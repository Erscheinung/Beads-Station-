import { Component, type ReactNode } from 'react'

/** One pane's render failure stays in that pane; the other panes and their shells carry on. */
export class PaneBoundary extends Component<{ paneId: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) { return { error: String(error) } }
  render() {
    if (this.state.error === null) return this.props.children
    return <div data-pane-error={this.props.paneId} role="alert" style={{ height: '100%', display: 'grid', placeContent: 'center', gap: 8, padding: 16, textAlign: 'center', background: 'var(--bs-bg)', color: 'var(--bs-fg-muted)', fontSize: 12 }}>
      <strong style={{ color: 'var(--bs-fg)' }}>This pane stopped drawing.</strong>
      <span>Its shell or agent is still running. {this.state.error}</span>
      <button onClick={() => this.setState({ error: null })}>Draw it again</button>
    </div>
  }
}
