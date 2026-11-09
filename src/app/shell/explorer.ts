import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AGENT_META } from '../core/protocol';
import { RunsService } from '../core/runs.service';
import { ThreadsService } from '../core/threads.service';
import { KEYS } from '../core/keys';
import { WorkspaceService, tabKey } from '../core/workspace.service';
import { AgentAvatar } from './agent-avatar';
import { FileIcon } from './file-icon';

interface Row {
  key: string;
  depth: number;
  name: string;
  path: string;
  dir: boolean;
  /** Folders only: whether its children show. */
  open: boolean;
  status: string | null;
  here: boolean;
}

/** The selected task's worktree as a tree; files the agent changed carry its colour and M/A. */
@Component({
  selector: 'tg-explorer',
  imports: [AgentAvatar, FileIcon],
  template: `
    <div class="panel-head">
      <span class="label">TỆP</span>
      <span class="spacer"></span>
      @if (run(); as r) {
        <div class="segmented" role="group" aria-label="Xem tệp của">
          <button [class.active]="view() === 'project'" [attr.aria-pressed]="view() === 'project'" (click)="choice.set('project')">Dự án</button>
          <button [class.active]="view() === 'draft'" [attr.aria-pressed]="view() === 'draft'" (click)="choice.set('draft')">Bản nháp</button>
        </div>
        <tg-agent-avatar [agent]="r.agent" [size]="14" />
      }
      @if (view() === 'project' && workspace.folder()) {
        <button class="btn ghost sm icon-btn" aria-label="Thu gọn mọi thư mục" title="Thu gọn mọi thư mục" (click)="collapseAll()">⊟</button>
        <button class="btn ghost sm icon-btn" aria-label="Tải lại danh sách tệp" title="Tải lại danh sách tệp" (click)="workspace.reloadProjectFiles()">↻</button>
      }
    </div>
    @if (view() === 'draft' || workspace.folder()) {
      <div class="tree-filter">
        <input #f type="search" [value]="filter()" (input)="filter.set(f.value)" (keydown.escape)="filter.set('')"
          placeholder="Lọc tệp…" aria-label="Lọc tệp theo tên" spellcheck="false" autocomplete="off" />
        <span class="kbd" title="Mở nhanh tệp">{{ keys.quickOpen }}</span>
      </div>
    }
    <div class="tree" role="tree" aria-label="Tệp của dự án hoặc bản nháp" [style.--agent]="color()">
      @if (view() === 'project') {
        @if (!workspace.folder()) {
          <div class="pad">
            <p class="dim">Chưa mở dự án nào.</p>
            <button class="btn primary sm" (click)="workspace.pickFolder()">Mở thư mục</button>
          </div>
        } @else if (workspace.projectFilesError(); as e) {
          <p class="error-text pad" role="alert">{{ e }}</p>
        } @else {
          @for (row of rows(); track row.key) {
            @if (row.dir) {
              <div class="tree-dir">
                <button class="tree-row" role="treeitem" [attr.aria-expanded]="row.open" [style.padding-left.px]="10 + row.depth * 12" (click)="toggle(row.path)">
                  <span class="twisty" aria-hidden="true">{{ row.open ? '▾' : '▸' }}</span>
                  <tg-file-icon [name]="row.name" [dir]="true" [open]="row.open" />
                  <span class="ellipsis">{{ row.name }}</span>
                </button>
                <button class="tl-add" [attr.aria-label]="'Trò chuyện mới trong thư mục ' + row.path" title="Trò chuyện mới trong thư mục này" (click)="threads.newChat(workspace.folder(), row.path)">+</button>
              </div>
            } @else {
              <button class="tree-row" role="treeitem" [class.active]="row.key === activeKey()" [style.padding-left.px]="18 + row.depth * 12"
                [title]="row.path" (click)="workspace.openSource(row.path, true)" (dblclick)="workspace.openSource(row.path)">
                <tg-file-icon [name]="row.name" />
                <span class="ellipsis">{{ row.name }}</span>
              </button>
            }
          } @empty {
            <p class="dim pad">{{ filter() ? 'Không có tệp nào khớp.' : 'Thư mục này chưa có tệp nào.' }}</p>
          }
        }
      } @else if (run(); as r) {
        @if (workspace.refreshErrors()[r.id]; as e) {
          <p class="error-text pad" role="alert">Chưa tải lại được tệp, đang hiện bản trước. {{ e }}</p>
        }
        @for (row of rows(); track row.key) {
          @if (row.dir) {
            <button class="tree-row" role="treeitem" [attr.aria-expanded]="row.open" [style.padding-left.px]="10 + row.depth * 12" (click)="toggle(row.path)">
              <span class="twisty" aria-hidden="true">{{ row.open ? '▾' : '▸' }}</span>
              <tg-file-icon [name]="row.name" [dir]="true" [open]="row.open" />
              <span class="ellipsis">{{ row.name }}</span>
            </button>
          } @else {
            <button class="tree-row" role="treeitem" [class.active]="row.key === activeKey()" [style.padding-left.px]="18 + row.depth * 12"
              [title]="row.path" (click)="open(r.id, row.path, true)" (dblclick)="open(r.id, row.path, false)">
              <tg-file-icon [name]="row.name" />
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
          <p class="dim pad">{{ filter() ? 'Không có tệp nào khớp.' : 'Bản nháp chưa có tệp.' }}</p>
        }
      }
    </div>
    @if (tasks().length) {
      <div class="panel-head worktrees-head"><span class="label">BẢN NHÁP</span><span class="dim">{{ tasks().length }}</span></div>
      <div class="worktrees">
        @for (t of tasks(); track t.id) {
          <button class="tree-row" [class.active]="t.id === run()?.id" (click)="runs.selectedId.set(t.id); choice.set('draft')">
            <tg-agent-avatar [agent]="t.agent" [size]="14" />
            <span class="ellipsis">{{ t.prompt || meta[t.agent].name }}</span>
            <span class="spacer"></span>
            <span class="status" [attr.data-status]="t.status">{{ statusLabel[t.status] }}</span>
          </button>
        }
      </div>
    }
  `,
})
export class Explorer {
  protected readonly runs = inject(RunsService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly threads = inject(ThreadsService);
  protected readonly meta = AGENT_META;
  protected readonly statusLabel = { running: 'đang chạy', idle: 'chờ bạn', done: 'xong', failed: 'lỗi', stopped: 'đã dừng', interrupted: 'gián đoạn' };
  protected readonly keys = KEYS;
  /** Draft view: folders the user folded. A draft is small, so it starts unfolded. */
  protected readonly collapsed = signal(new Set<string>());
  /** Project view: folders the user unfolded. A project can be large, so it starts folded. */
  protected readonly expanded = signal(new Set<string>());
  /** Part of a path to match; while set, every folder with a match is unfolded. */
  protected readonly filter = signal('');
  /** The selected run, if it is a code task with a worktree. */
  protected readonly run = computed(() => {
    const r = this.runs.selected();
    return r?.task ? r : null;
  });
  protected readonly tasks = computed(() => this.runs.runs().filter((r) => r.task));
  /** Which files to show when a task is selected. Without a task only the project has files. */
  protected readonly choice = signal<'project' | 'draft'>('draft');
  protected readonly view = computed(() => (this.run() ? this.choice() : 'project'));
  protected readonly color = computed(() => (this.run() ? AGENT_META[this.run()!.agent].color : null));
  protected readonly activeKey = computed(() => this.workspace.activeKey());
  private readonly activity = computed(() => {
    const r = this.run();
    return r && r.status === 'running' ? (this.runs.activity()[r.id] ?? null) : null;
  });
  protected readonly hereLabel = computed(() => (this.activity()?.editing ? 'đang sửa' : 'đang xem'));

  protected readonly rows = computed<Row[]>(() => {
    const r = this.view() === 'draft' ? this.run() : null;
    const root = this.workspace.folder();
    const files = r ? (this.workspace.files()[r.id] ?? []) : this.workspace.projectFiles();
    const status = new Map(r ? (this.workspace.diffs()[r.id] ?? []).map((f) => [f.path, f.status]) : []);
    // Deleted files are not on disk but still belong in the tree.
    const q = this.filter().trim().toLowerCase();
    const all = [...new Set([...files, ...status.keys()])].filter((p) => !q || p.toLowerCase().includes(q)).sort(byFolderThenName);
    const draft = !!r;
    const expanded = this.expanded();
    const isOpen = (dir: string) => !!q || (draft ? !hidden.has(dir) : expanded.has(dir));
    const a = r ? this.activity() : null;
    const here = r && a ? this.workspace.relative(r.id, a.path) : null;
    const hidden = this.collapsed();
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const path of all) {
      const parts = path.split('/');
      let skip = false;
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        if (skip) break;
        if (!seen.has(dir)) {
          seen.add(dir);
          rows.push({ key: `d:${dir}`, depth: i, name: parts[i], path: dir, dir: true, open: isOpen(dir), status: null, here: false });
        }
        if (!isOpen(dir)) skip = true;
      }
      if (skip) continue;
      rows.push({
        key: tabKey(r ? { kind: 'file', runId: r.id, path } : { kind: 'source', root, path }), depth: parts.length - 1, name: parts.at(-1)!, path, dir: false, open: false,
        status: status.get(path) ?? null, here: path === here,
      });
    }
    return rows;
  });

  constructor() {
    // Reveal the open file: unfold the folders above it, then bring its row into view.
    effect(() => {
      const tab = this.workspace.active();
      const path = tab?.kind === 'source' || tab?.kind === 'file' ? tab.path : null;
      if (!path) return;
      untracked(() => {
        const dirs = ancestors(path);
        if (tab!.kind === 'source') {
          if (dirs.some((d) => !this.expanded().has(d))) this.expanded.set(new Set([...this.expanded(), ...dirs]));
        } else if (dirs.some((d) => this.collapsed().has(d))) {
          const next = new Set(this.collapsed());
          dirs.forEach((d) => next.delete(d));
          this.collapsed.set(next);
        }
        setTimeout(() => document.querySelector('.side-files .tree-row.active')?.scrollIntoView({ block: 'nearest' }));
      });
    });
  }

  protected toggle(dir: string): void {
    if (this.filter().trim()) return;
    if (this.view() === 'project') {
      const next = new Set(this.expanded());
      if (!next.delete(dir)) next.add(dir);
      this.expanded.set(next);
    } else {
      const next = new Set(this.collapsed());
      if (!next.delete(dir)) next.add(dir);
      this.collapsed.set(next);
    }
  }

  protected collapseAll(): void {
    this.expanded.set(new Set());
  }

  protected open(runId: string, path: string, preview: boolean): void {
    if (this.run()?.status === 'running') this.workspace.follow.set(false);
    this.workspace.openFile(runId, path, preview);
  }
}

/** `a/b/c.ts` → `a`, `a/b`. */
function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
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
