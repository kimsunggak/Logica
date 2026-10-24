/** Paper templates offered by "New paper". Their files live in src-tauri/templates/<id>. */
import type { MessageKey } from "../i18n";

export type PaperTemplateId = "cvpr" | "blank";

export const PAPER_TEMPLATES: { id: PaperTemplateId; label: MessageKey; hint: MessageKey }[] = [
  { id: "cvpr", label: "template.cvpr", hint: "template.cvprHint" },
  { id: "blank", label: "template.blank", hint: "template.blankHint" },
];
