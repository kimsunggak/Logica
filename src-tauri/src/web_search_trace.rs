//! Web search in a raw provider stream, for the debug visualizer.
//!
//! When a chat request offers the provider's built-in web search tool, the
//! searches run on the provider's servers inside the same streamed response.
//! This reads that stream as the provider sent it, independently of the
//! webview's parser, and reports each search (query, result count or error),
//! the cited sources, and a Claude turn paused for continuation.
//!
//! Only requests the debug visualizer traces are read, in debug builds.

use std::collections::HashMap;

use serde_json::{json, Value};

/// Longest query or source title kept, in characters.
const MAX_TEXT: usize = 200;
/// Cited sources kept per request.
const MAX_CITATIONS: usize = 20;

/// Whether a request body offers a built-in web search tool: Claude's
/// `web_search_YYYYMMDD` or OpenAI's `web_search` / `web_search_preview`.
pub fn offers_web_search(body: &Value) -> bool {
    body.get("tools").and_then(Value::as_array).is_some_and(|tools| {
        tools
            .iter()
            .any(|tool| tool.get("type").and_then(Value::as_str).is_some_and(|kind| kind.starts_with("web_search")))
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
enum Status {
    #[default]
    Searching,
    Done,
    Error,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Searching => "searching",
            Status::Done => "done",
            Status::Error => "error",
        }
    }
}

/// One `web_search` call. Besides searching, an OpenAI call may open a page
/// (`open_page`) or look for text in one (`find_in_page`).
#[derive(Default)]
struct Search {
    /// `search`, `open_page` or `find_in_page`; unknown until the call says.
    action: Option<String>,
    queries: Vec<String>,
    /// The page an `open_page` / `find_in_page` call read, and the text it looked for.
    url: Option<String>,
    pattern: Option<String>,
    status: Status,
    results: Option<usize>,
    error: Option<String>,
    started_ms: u128,
    ended_ms: Option<u128>,
}

/// A live update for a `span_data` event: its label and value.
pub type Update = (&'static str, Value);

/// The searches of one provider stream, read event by event.
#[derive(Default)]
pub struct WebSearchLog {
    /// The unfinished last line of the stream so far.
    line: String,
    searches: Vec<Search>,
    /// Claude server tool use id or OpenAI output item id -> search.
    by_id: HashMap<String, usize>,
    /// Claude content block index -> its search and the query JSON so far.
    inputs: HashMap<u64, (usize, String)>,
    citations: Vec<(String, Option<String>)>,
    /// Searches the provider reports as billed (Claude's usage).
    billed: Option<u64>,
    stop_reason: Option<String>,
}

impl WebSearchLog {
    /// Read a chunk of the raw response body; returns the live updates it caused.
    pub fn push(&mut self, chunk: &str, ms: u128) -> Vec<Update> {
        self.line.push_str(chunk);
        let mut updates = Vec::new();
        while let Some(end) = self.line.find('\n') {
            let line: String = self.line.drain(..=end).collect();
            self.read_line(line.trim_end_matches(['\n', '\r']), ms, &mut updates);
        }
        updates
    }

    /// Every search and cited source of the stream, for the span's output.
    pub fn finish(&mut self, ms: u128) -> Value {
        // A last event without a closing newline.
        let rest = std::mem::take(&mut self.line);
        self.read_line(rest.trim_end_matches('\r'), ms, &mut Vec::new());
        json!({
            "searches": (0..self.searches.len()).map(|i| self.search_json(i)).collect::<Vec<_>>(),
            "citations": self.citations.iter().map(|(url, title)| json!({ "url": url, "title": title })).collect::<Vec<_>>(),
            "billed_searches": self.billed,
            "stop_reason": self.stop_reason,
        })
    }

    fn read_line(&mut self, line: &str, ms: u128, updates: &mut Vec<Update>) {
        let Some(data) = line.strip_prefix("data:") else { return };
        // `[DONE]` and anything else that is not an event object.
        let Ok(event) = serde_json::from_str::<Value>(data.trim_start()) else { return };
        match event["type"].as_str().unwrap_or("") {
            // Claude (Messages API)
            "content_block_start" => self.block_start(&event, ms, updates),
            "content_block_delta" => self.block_delta(&event),
            "content_block_stop" => self.block_stop(&event, updates),
            "message_delta" => self.message_delta(&event, ms, updates),
            // OpenAI (Responses API)
            "response.output_item.added" => self.openai_item(&event["item"], false, ms, updates),
            "response.output_item.done" => self.openai_item(&event["item"], true, ms, updates),
            "response.web_search_call.in_progress" | "response.web_search_call.searching" => {
                let (i, new) = self.search(event["item_id"].as_str(), ms);
                if new {
                    updates.push(self.update(i));
                }
            }
            "response.web_search_call.completed" => {
                let (i, new) = self.search(event["item_id"].as_str(), ms);
                if self.end(i, Status::Done, None, None, ms) || new {
                    updates.push(self.update(i));
                }
            }
            "response.output_text.annotation.added" => self.annotation(&event["annotation"]),
            "response.completed" => self.openai_completed(&event, ms, updates),
            _ => {}
        }
    }

    fn block_start(&mut self, event: &Value, ms: u128, updates: &mut Vec<Update>) {
        let block = &event["content_block"];
        match block["type"].as_str() {
            Some("server_tool_use") if block["name"] == "web_search" => {
                let (i, _) = self.search(block["id"].as_str(), ms);
                self.searches[i].action = Some("search".into());
                if let Some(query) = block["input"]["query"].as_str() {
                    self.searches[i].queries = vec![clip(query)];
                }
                if let Some(index) = event["index"].as_u64() {
                    self.inputs.insert(index, (i, String::new()));
                }
                updates.push(self.update(i));
            }
            Some("web_search_tool_result") => {
                let (i, _) = self.search(block["tool_use_id"].as_str(), ms);
                // Results come as a list; a failed search as one error object.
                match &block["content"] {
                    Value::Array(results) => self.end(i, Status::Done, Some(results.len()), None, ms),
                    other => {
                        let code = other["error_code"].as_str().unwrap_or("unknown").to_string();
                        self.end(i, Status::Error, None, Some(code), ms)
                    }
                };
                updates.push(self.update(i));
            }
            _ => {}
        }
    }

    fn block_delta(&mut self, event: &Value) {
        let delta = &event["delta"];
        match delta["type"].as_str() {
            Some("input_json_delta") => {
                if let (Some(index), Some(part)) = (event["index"].as_u64(), delta["partial_json"].as_str()) {
                    if let Some((_, input)) = self.inputs.get_mut(&index) {
                        input.push_str(part);
                    }
                }
            }
            Some("citations_delta") => self.cite(&delta["citation"]),
            _ => {}
        }
    }

    /// The query of a Claude search is complete once its block ends.
    fn block_stop(&mut self, event: &Value, updates: &mut Vec<Update>) {
        let Some((i, input)) = event["index"].as_u64().and_then(|index| self.inputs.remove(&index)) else { return };
        let query = serde_json::from_str::<Value>(&input).ok().and_then(|v| v["query"].as_str().map(clip));
        if let Some(query) = query {
            if self.searches[i].queries != [query.as_str()] {
                self.searches[i].queries = vec![query];
                updates.push(self.update(i));
            }
        }
    }

    fn message_delta(&mut self, event: &Value, ms: u128, updates: &mut Vec<Update>) {
        if let Some(reason) = event["delta"]["stop_reason"].as_str() {
            self.stop_reason = Some(reason.to_string());
            // The server's search loop ran long; the turn continues in a new request.
            if reason == "pause_turn" {
                updates.push(("pause_turn", json!({ "searches": self.searches.len(), "at_ms": ms as u64 })));
            }
        }
        if let Some(count) = event["usage"]["server_tool_use"]["web_search_requests"].as_u64() {
            self.billed = Some(count);
        }
    }

    fn openai_item(&mut self, item: &Value, done: bool, ms: u128, updates: &mut Vec<Update>) {
        if item["type"] != "web_search_call" {
            return;
        }
        let (i, new) = self.search(item["id"].as_str(), ms);
        let mut changed = self.read_action(i, &item["action"]) || new;
        changed |= match item["status"].as_str() {
            Some("failed") => self.end(i, Status::Error, None, Some("failed".into()), ms),
            Some("completed") => self.end(i, Status::Done, None, None, ms),
            _ if done => self.end(i, Status::Done, None, None, ms),
            _ => false,
        };
        if changed {
            updates.push(self.update(i));
        }
    }

    /// What an OpenAI call did: every query of a search (as the webview reads
    /// them), or the page it opened or searched in. False when nothing is new.
    fn read_action(&mut self, i: usize, action: &Value) -> bool {
        let queries: Vec<String> = match &action["queries"] {
            Value::Array(list) => list.iter().filter_map(Value::as_str).map(str::trim).filter(|q| !q.is_empty()).map(clip).collect(),
            _ => action["query"].as_str().map(str::trim).filter(|q| !q.is_empty()).map(clip).into_iter().collect(),
        };
        let kind = match action["type"].as_str() {
            // Older API versions name the in-page search `find`.
            Some("find") => Some("find_in_page".to_string()),
            Some(kind) => Some(kind.to_string()),
            None => (!queries.is_empty()).then(|| "search".to_string()),
        };
        let search = &mut self.searches[i];
        let mut changed = false;
        if kind.is_some() && search.action != kind {
            search.action = kind;
            changed = true;
        }
        if !queries.is_empty() && search.queries != queries {
            search.queries = queries;
            changed = true;
        }
        for (field, key) in [(&mut search.url, "url"), (&mut search.pattern, "pattern")] {
            let value = action[key].as_str().map(clip);
            if value.is_some() && *field != value {
                *field = value;
                changed = true;
            }
        }
        changed
    }

    /// The final response repeats every item; fill in anything the stream missed.
    fn openai_completed(&mut self, event: &Value, ms: u128, updates: &mut Vec<Update>) {
        let Some(output) = event["response"]["output"].as_array() else { return };
        for item in output {
            match item["type"].as_str() {
                Some("web_search_call") => self.openai_item(item, true, ms, updates),
                Some("message") => {
                    for part in item["content"].as_array().into_iter().flatten() {
                        for annotation in part["annotations"].as_array().into_iter().flatten() {
                            self.annotation(annotation);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn annotation(&mut self, annotation: &Value) {
        if annotation["type"] == "url_citation" {
            self.cite(annotation);
        }
    }

    /// A cited source, once per URL.
    fn cite(&mut self, citation: &Value) {
        let Some(url) = citation["url"].as_str() else { return };
        if self.citations.len() < MAX_CITATIONS && !self.citations.iter().any(|(known, _)| known == url) {
            self.citations.push((url.to_string(), citation["title"].as_str().map(clip)));
        }
    }

    /// The search with this id, started now if it is new.
    fn search(&mut self, id: Option<&str>, ms: u128) -> (usize, bool) {
        if let Some(&i) = id.and_then(|id| self.by_id.get(id)) {
            return (i, false);
        }
        self.searches.push(Search { started_ms: ms, ..Search::default() });
        let i = self.searches.len() - 1;
        if let Some(id) = id {
            self.by_id.insert(id.to_string(), i);
        }
        (i, true)
    }

    /// Record how a search ended; false when nothing changed.
    fn end(&mut self, i: usize, status: Status, results: Option<usize>, error: Option<String>, ms: u128) -> bool {
        let search = &mut self.searches[i];
        let results = results.or(search.results);
        if search.status == status && search.results == results && search.error == error {
            return false;
        }
        search.status = status;
        search.results = results;
        search.error = error;
        search.ended_ms.get_or_insert(ms);
        true
    }

    fn update(&self, i: usize) -> Update {
        ("web_search", self.search_json(i))
    }

    fn search_json(&self, i: usize) -> Value {
        let search = &self.searches[i];
        let mut value = json!({
            "n": i + 1,
            "action": search.action,
            "status": search.status.as_str(),
            "query": search.queries.first(),
            "results": search.results,
            "error": search.error,
            "duration_ms": search.ended_ms.map(|end| end.saturating_sub(search.started_ms) as u64),
        });
        if search.queries.len() > 1 {
            value["queries"] = json!(search.queries);
        }
        if let Some(url) = &search.url {
            value["url"] = json!(url);
        }
        if let Some(pattern) = &search.pattern {
            value["pattern"] = json!(pattern);
        }
        value
    }
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sse(events: &[Value]) -> String {
        events.iter().map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap_or("message"))).collect()
    }

    /// Feed the stream in small pieces, as the network delivers it.
    fn read(log: &mut WebSearchLog, stream: &str) -> Vec<Update> {
        let chars: Vec<char> = stream.chars().collect();
        chars.chunks(7).enumerate().flat_map(|(i, piece)| log.push(&piece.iter().collect::<String>(), i as u128)).collect()
    }

    #[test]
    fn finds_the_web_search_tool_in_a_request() {
        assert!(offers_web_search(&json!({ "tools": [{ "name": "apply", "input_schema": {} }, { "type": "web_search_20260318", "name": "web_search" }] })));
        assert!(offers_web_search(&json!({ "tools": [{ "type": "web_search" }] })));
        assert!(offers_web_search(&json!({ "tools": [{ "type": "web_search_preview" }] })));
        assert!(!offers_web_search(&json!({ "tools": [{ "type": "function", "name": "route_chat" }] })));
        assert!(!offers_web_search(&json!({ "model": "m" })));
    }

    #[test]
    fn reads_claude_searches_queries_results_and_citations() {
        let stream = sse(&[
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 10 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Let me look that up." } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"query\": \"latent diff" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "usion 2026\"}" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [
                { "type": "web_search_result", "url": "https://a.example/1", "title": "A", "encrypted_content": "x" },
                { "type": "web_search_result", "url": "https://b.example/2", "title": "B", "encrypted_content": "y" }
            ] } }),
            json!({ "type": "content_block_stop", "index": 2 }),
            json!({ "type": "content_block_start", "index": 3, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 3, "delta": { "type": "citations_delta", "citation": { "type": "web_search_result_location", "url": "https://a.example/1", "title": "A", "cited_text": "…" } } }),
            json!({ "type": "content_block_delta", "index": 3, "delta": { "type": "citations_delta", "citation": { "type": "web_search_result_location", "url": "https://a.example/1", "title": "A", "cited_text": "again" } } }),
            json!({ "type": "content_block_delta", "index": 3, "delta": { "type": "text_delta", "text": "The survey says…" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 20, "server_tool_use": { "web_search_requests": 1 } } }),
            json!({ "type": "message_stop" }),
        ]);
        let mut log = WebSearchLog::default();
        let updates = read(&mut log, &stream);

        let states: Vec<(&str, &str)> = updates.iter().map(|(label, v)| (*label, v["status"].as_str().unwrap_or(""))).collect();
        assert_eq!(states, [("web_search", "searching"), ("web_search", "searching"), ("web_search", "done")]);
        assert_eq!(updates[0].1["query"], Value::Null);
        assert_eq!(updates[1].1["query"], "latent diffusion 2026");
        assert_eq!(updates[2].1["results"], 2);

        let summary = log.finish(999);
        assert_eq!(summary["searches"].as_array().unwrap().len(), 1);
        assert_eq!(summary["searches"][0]["n"], 1);
        assert_eq!(summary["searches"][0]["query"], "latent diffusion 2026");
        assert_eq!(summary["searches"][0]["action"], "search");
        assert_eq!(summary["citations"], json!([{ "url": "https://a.example/1", "title": "A" }]));
        assert_eq!(summary["billed_searches"], 1);
        assert_eq!(summary["stop_reason"], "end_turn");
    }

    #[test]
    fn reports_claude_search_errors_and_paused_turns() {
        let stream = sse(&[
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "server_tool_use", "id": "srvtoolu_9", "name": "web_search", "input": { "query": "q" } } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "web_search_tool_result", "tool_use_id": "srvtoolu_9",
                "content": { "type": "web_search_tool_result_error", "error_code": "max_uses_exceeded" } } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "pause_turn" } }),
        ]);
        let mut log = WebSearchLog::default();
        let updates = read(&mut log, &stream);
        assert_eq!(updates.last().unwrap().0, "pause_turn");
        let summary = log.finish(5);
        assert_eq!(summary["searches"][0]["status"], "error");
        assert_eq!(summary["searches"][0]["error"], "max_uses_exceeded");
        assert_eq!(summary["searches"][0]["query"], "q");
        assert_eq!(summary["stop_reason"], "pause_turn");
    }

    #[test]
    fn ignores_client_tools_and_other_server_tools() {
        let stream = sse(&[
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "apply_paper_edits", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{\"query\": \"no\"}" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "server_tool_use", "id": "srvtoolu_2", "name": "web_fetch", "input": {} } }),
        ]);
        let mut log = WebSearchLog::default();
        assert!(read(&mut log, &stream).is_empty());
        assert_eq!(log.finish(0)["searches"], json!([]));
    }

    #[test]
    fn reads_openai_search_calls_and_url_citations() {
        let item = |status: &str, action: Value| json!({ "type": "web_search_call", "id": "ws_1", "status": status, "action": action });
        let stream = sse(&[
            json!({ "type": "response.created" }),
            json!({ "type": "response.output_item.added", "output_index": 0, "item": item("in_progress", Value::Null) }),
            json!({ "type": "response.web_search_call.in_progress", "item_id": "ws_1", "output_index": 0 }),
            json!({ "type": "response.web_search_call.searching", "item_id": "ws_1", "output_index": 0 }),
            json!({ "type": "response.web_search_call.completed", "item_id": "ws_1", "output_index": 0 }),
            json!({ "type": "response.output_item.done", "output_index": 0, "item": item("completed", json!({ "type": "search", "query": "guidance scale ablation" })) }),
            json!({ "type": "response.output_text.delta", "delta": "Recent work…" }),
            json!({ "type": "response.output_text.annotation.added", "annotation": { "type": "url_citation", "url": "https://c.example/3", "title": "C", "start_index": 0, "end_index": 4 } }),
            json!({ "type": "response.completed", "response": { "output": [
                item("completed", json!({ "type": "search", "query": "guidance scale ablation" })),
                { "type": "message", "content": [{ "type": "output_text", "text": "…", "annotations": [
                    { "type": "url_citation", "url": "https://c.example/3", "title": "C" },
                    { "type": "url_citation", "url": "https://d.example/4", "title": "D" }
                ] }] }
            ] } }),
        ]);
        let mut log = WebSearchLog::default();
        let updates = read(&mut log, &stream);
        let states: Vec<&str> = updates.iter().map(|(_, v)| v["status"].as_str().unwrap_or("")).collect();
        assert_eq!(states, ["searching", "done", "done"]);
        assert_eq!(updates[2].1["query"], "guidance scale ablation");

        let summary = log.finish(10);
        assert_eq!(summary["searches"].as_array().unwrap().len(), 1);
        assert_eq!(summary["searches"][0]["query"], "guidance scale ablation");
        assert_eq!(summary["citations"].as_array().unwrap().len(), 2);
        assert_eq!(summary["billed_searches"], Value::Null);
    }

    #[test]
    fn tells_openai_page_actions_from_searches_and_keeps_every_query() {
        let call = |id: &str, action: Value| json!({ "type": "response.output_item.done", "item": { "type": "web_search_call", "id": id, "status": "completed", "action": action } });
        let stream = sse(&[
            call("ws_1", json!({ "type": "search", "queries": ["guidance scale ablation", " CFG 2026 ", ""] })),
            call("ws_2", json!({ "type": "open_page", "url": "https://arxiv.org/abs/2601.00001" })),
            call("ws_3", json!({ "type": "find", "url": "https://arxiv.org/abs/2601.00001", "pattern": "FID" })),
            call("ws_4", Value::Null),
        ]);
        let mut log = WebSearchLog::default();
        read(&mut log, &stream);
        let summary = log.finish(0);
        let s = &summary["searches"];
        assert_eq!(s[0]["action"], "search");
        assert_eq!(s[0]["query"], "guidance scale ablation");
        assert_eq!(s[0]["queries"], json!(["guidance scale ablation", "CFG 2026"]));
        assert_eq!(s[1]["action"], "open_page");
        assert_eq!(s[1]["url"], "https://arxiv.org/abs/2601.00001");
        assert_eq!(s[1]["query"], Value::Null);
        assert_eq!(s[2]["action"], "find_in_page");
        assert_eq!(s[2]["pattern"], "FID");
        // No action reported: done, but what it did is unknown.
        assert_eq!(s[3]["action"], Value::Null);
        assert_eq!(s[3]["status"], "done");
        assert!(s[3].get("url").is_none() && s[3].get("queries").is_none());
    }

    #[test]
    fn keeps_a_final_event_without_a_newline_and_skips_done_markers() {
        let mut log = WebSearchLog::default();
        assert!(log.push("data: [DONE]\n\n: ping\n", 0).is_empty());
        let last = json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "server_tool_use", "id": "s", "name": "web_search", "input": {} } });
        assert!(log.push(&format!("data: {last}"), 1).is_empty());
        assert_eq!(log.finish(2)["searches"][0]["status"], "searching");
    }
}
