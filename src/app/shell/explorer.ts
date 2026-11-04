import { Component, computed, inject, signal } from '@angular/core';
import { AGENT_META } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { WorkspaceService, tabKey } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';

interface Row {
  key: string;
  depth: number;
  name: string;
  path: string;
  dir: boolean;
  status: string | null;
  here: boolean;
}

/** The selected task's worktree as a tree; files the agent changed carry its colour and M/A. */
@Component({
  selector: 'tg-explorer',
  imports: [AgentAvatar],
  template: `
    <div class="panel-head">
      <span class="label">EXPLORER</span>
      <span class="spacer"></span>
      @if (run(); as r) { <tg-agent-avatar [agent]="r.agent" [size]="14" /> }
    </div>
    <div class="tree" role="tree" aria-label="Tệp trong worktree" [style.--agent]="color()">
      @if (run(); as r) {
        @for (row of rows(); track row.key) {
          @if (row.dir) {
            <button class="tree-row" role="treeitem" [attr.aria-expanded]="!collapsed().has(row.path)" [style.padding-left.px]="10 + row.depth * 12" (click)="toggle(row.path)">
              <span class="twisty" aria-hidden="true">{{ collapsed().has(row.path) ? '▸' : '▾' }}</span>
              <span class="ellipsis">{{ row.name }}</span>
            </button>
          } @else {
            <button class="tree-row" role="treeitem" [class.active]="row.key === activeKey()" [style.padding-left.px]="22 + row.depth * 12" (click)="open(r.id, row.path)">
              <span class="ellipsis">{{ row.name }}</span>
              <span class="spacer"></span>
              @if (row.here) { <span class="agent-here">{{ hereLabel() }}</span> }
              @if (row.status) {
                <span class="agent-dot" aria-hidden="true"></span>
                <span class="file-status" [attr.data-status]="row.status">{{ row.status }}</span>
              }
            </button>
          }
        } @empty {
          <p class="dim pad">Worktree chưa có tệp.</p>
        }
      } @else if (!workspace.folder()) {
        <div class="pad">
          <p class="dim">Chưa mở dự án nào.</p>
          <button class="btn primary sm" (click)="workspace.pickFolder()">Mở thư mục</button>
        </div>
      } @else {
        <p class="dim pad">Chọn một task Sửa code (ở mục Worktrees bên dưới hoặc tab Runs) để xem tệp của nó. Giao việc ở ô bên phải.</p>
      }
    </div>
    <div class="panel-head worktrees-head"><span class="label">WORKTREES</span><span class="dim">{{ tasks().length }}</span></div>
    <div class="worktrees">
      @for (t of tasks(); track t.id) {
        <button class="tree-row" [class.active]="t.id === run()?.id" (click)="runs.selectedId.set(t.id)">
          <tg-agent-avatar [agent]="t.agent" [size]="14" />
          <span class="ellipsis">{{ t.prompt || meta[t.agent].name }}</span>
          <span class="spacer"></span>
          <span class="status" [attr.data-status]="t.status">{{ statusLabel[t.status] }}</span>
        </button>
      } @empty {
        <p class="dim pad">Chưa có worktree nào.</p>
      }
    </div>
  `,
})
export class Explorer {
  protected readonly runs = inject(RunsService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly meta = AGENT_META;
  protected readonly statusLabel = { running: 'đang chạy', done: 'xong', failed: 'lỗi', stopped: 'đã dừng', interrupted: 'gián đoạn' };
  protected readonly collapsed = signal(new Set<string>());
  /** The selected run, if it is a code task with a worktree. */
  protected readonly run = computed(() => {
    const r = this.runs.selected();
    return r?.task ? r : null;
  });
  protected readonly tasks = computed(() => this.runs.runs().filter((r) => r.task));
  protected readonly color = computed(() => (this.run() ? AGENT_META[this.run()!.agent].color : null));
  protected readonly activeKey = computed(() => this.workspace.activeKey());
  private readonly activity = computed(() => {
    const r = this.run();
    return r && r.status === 'running' ? (this.runs.activity()[r.id] ?? null) : null;
  });
  protected readonly hereLabel = computed(() => (this.activity()?.editing ? 'đang sửa' : 'đang xem'));

  protected readonly rows = computed<Row[]>(() => {
    const r = this.run();
    if (!r) return [];
    const files = this.workspace.files()[r.id] ?? [];
    const status = new Map((this.workspace.diffs()[r.id] ?? []).map((f) => [f.path, f.status]));
    // Deleted files are not on disk but still belong in the tree.
    const all = [...new Set([...files, ...status.keys()])].sort(byFolderThenName);
    const a = this.activity();
    const here = a ? this.workspace.relative(r.id, a.path) : null;
    const rows: Row[] = [];
    const seen = new Set<string>();
    const hidden = this.collapsed();
    for (const path of all) {
      const parts = path.split('/');
      let skip = false;
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        if (skip) break;
        if (!seen.has(dir)) {
          seen.add(dir);
          rows.push({ key: `d:${dir}`, depth: i, name: parts[i], path: dir, dir: true, status: null, here: false });
        }
        if (hidden.has(dir)) skip = true;
      }
      if (skip) continue;
      rows.push({
        key: tabKey({ kind: 'file', runId: r.id, path }), depth: parts.length - 1, name: parts.at(-1)!, path, dir: false,
        status: status.get(path) ?? null, here: path === here,
      });
    }
    return rows;
  });

  protected toggle(dir: string): void {
    const next = new Set(this.collapsed());
    if (!next.delete(dir)) next.add(dir);
    this.collapsed.set(next);
  }

  protected open(runId: string, path: string): void {
    if (this.run()?.status === 'running') this.workspace.follow.set(false);
    this.workspace.openFile(runId, path);
  }
}

/** Folders before files at each level, like most editors. */
function byFolderThenName(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aDir = i < pa.length - 1;
    const bDir = i < pb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return pa[i].localeCompare(pb[i]);
  }
  return pa.length - pb.length;
}
