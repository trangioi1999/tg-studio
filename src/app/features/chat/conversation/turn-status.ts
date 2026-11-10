import { Run } from '../../../services/runs/run';

export type TurnStatus = 'running' | 'needs_you' | 'waiting' | 'failed' | 'stopped';

/** How the run's current turn stands; an open session waits after every turn, but how that turn ended still shows. */
export function turnStatus(r: Run): TurnStatus {
  if (r.permissions.length) return 'needs_you';
  if (r.status === 'running') return 'running';
  if (r.status === 'failed' || r.lastTurn === 'failed') return 'failed';
  if (r.status === 'stopped' || r.status === 'interrupted' || r.lastTurn === 'stopped') return 'stopped';
  return 'waiting';
}
