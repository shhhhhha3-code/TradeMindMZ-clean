import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Slim inline mode — just shows a small error card instead of full-page */
  inline?: boolean;
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    if (this.props.inline) {
      return (
        <div className="flex items-center gap-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
          <span className="text-destructive flex-1 min-w-0 truncate">
            {this.props.label ?? 'Section'} failed to load
          </span>
          <button onClick={this.reset}
            className="shrink-0 text-destructive hover:text-destructive/80 underline">
            Retry
          </button>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] p-8 text-center gap-4">
        <div className="w-14 h-14 rounded-full flex items-center justify-center bg-destructive/10">
          <AlertTriangle className="w-7 h-7 text-destructive" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground mb-1">Something went wrong</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </p>
        </div>
        <Button variant="outline" onClick={this.reset} className="gap-2">
          <RefreshCw className="w-4 h-4" />
          Try Again
        </Button>
      </div>
    );
  }
}
