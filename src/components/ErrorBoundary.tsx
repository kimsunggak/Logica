import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a failure in one panel (PDF, chat, outline) from taking down the
 * rest of the workspace; the editor must stay usable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.name} panel crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[12px] text-slate-500">
        <div>The {this.props.name} panel hit an error.</div>
        <div className="max-w-full truncate font-mono text-[11px] text-red-600">{this.state.error.message}</div>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Reload panel
        </button>
      </div>
    );
  }
}
