/**
 * A browser tab on the dev server during `npm run tauri dev`: the app runs in
 * the Tauri window, so this tab waits for the runtime debugger (served by the
 * Rust app once it has been built) and switches to it.
 */
export function openDebugger(url: string): void {
  const root = document.getElementById("root")!;
  const message = document.createElement("p");
  message.className = "p-8 text-[14px] text-slate-600 dark:text-slate-300";
  message.textContent = `LOGICA 런타임 디버거(${url})가 뜨기를 기다리는 중입니다. 앱 빌드가 끝나면 자동으로 열립니다.`;
  root.replaceChildren(message);

  const tryOpen = async () => {
    try {
      // The debugger sends no CORS headers; an opaque response still proves it is up.
      await fetch(`${url}/health`, { mode: "no-cors", cache: "no-store" });
      location.replace(url);
    } catch {
      setTimeout(() => void tryOpen(), 1000);
    }
  };
  void tryOpen();
}
