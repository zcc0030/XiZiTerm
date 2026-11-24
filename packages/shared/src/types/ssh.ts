export type SshConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface SshConnectRequest {
  sessionId: string;
  hostId: string;
  cols: number;
  rows: number;
}

export interface SshConnectResult {
  ok: boolean;
  error?: string;
}

export interface SshTestConnectionRequest {
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshTestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  remoteInfo?: string;
  error?: string;
}

export interface SshResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface SshDataEvent {
  sessionId: string;
  data: string;
}

export interface SshStateEvent {
  sessionId: string;
  state: SshConnectionState;
  message?: string;
  code?: number | null;
}

export type SplitDirection = 'horizontal' | 'vertical';

export type TerminalSplitNode =
  | {
      type: 'pane';
      paneId: string;
      sessionId: string;
      hostId: string;
      hostName: string;
      hostAddress: string;
    }
  | {
      type: 'split';
      id: string;
      direction: SplitDirection;
      ratio: number; // 0.15 - 0.85
      first: TerminalSplitNode;
      second: TerminalSplitNode;
    };

export interface TerminalTab {
  tabId: string;
  title: string;
  hostId: string;
  root: TerminalSplitNode;
  activePaneId: string;
}
