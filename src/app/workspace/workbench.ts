import { Component, computed, effect, inject, untracked } from '@angular/core';
import { AGENT_META } from '../agents/agent-meta';
import { RunsService } from '../runs/runs.service';
import { Tab, WorkspaceService, tabKey } from './workspace.service';
import { CodeEditor } from './editor/code-editor';
import { Compare } from './compare';
import { DiffViewer } from './diff-viewer';
import { FileIcon } from '../shared/file-icon';
import { SourceViewer } from './editor/source-viewer';
import { Terminal } from './terminal';

/** Center of the IDE: tabs for files and reviews, with the agents' logs underneath. */
/** While an agent edits, file and diff reloads wait this long to batch several edits. */
const REFRESH_BATCH_MS = 1500;

@Component({
  selector: 'tg-workbench',
  imports: [CodeEditor, Compare, DiffViewer, FileIcon, SourceViewer, Terminal],
  template: `
    <div class="tabs" role="tablist" aria-label="Tab đang mở">
      @for (t of workspace.tabs(); track key(t)) {
        <div class="tab" role="tab" [class.active]="key(t) === workspace.activeKey()" [class.preview]="key(t) === workspace.previewKey()"
          [attr.aria-selected]="key(t) === workspace.activeKey()" [style.--agent]="colorOf(t)" (auxclick)="$event.button === 1 && workspace.close(key(t))">
          <button class="tab-open" [title]="tooltip(t)" (click)="workspace.activeKey.set(key(t)); selectRunOf(t)" (dblclick)="workspace.pin(key(t))">
            @if (t.kind === 'changes' || t.kind === 'compare') { <span class="tab-kind">{{ t.kind === 'changes' ? 'Thay đổi' : 'So sánh' }}</span> }
            @else { <tg-file-icon [name]="$any(t).path" /> }
            <span class="ellipsis">{{ title(t) }}</span>
            @if (pendingIn(t)) { <span class="agent-dot" aria-label="Agent có sửa tệp này, chưa commit"></span> }
          </button>
          <button class="tab-close" [attr.aria-label]="'Đóng ' + title(t)" (click)="workspace.close(key(t))">×</button>
        </div>
      }
      <span class="spacer"></span>
      @if (selectedTask(); as r) {
        <button class="btn ghost sm" (click)="workspace.open({ kind: 'changes', runId: r.id })">Thay đổi</button>
        @if (groupSize(r.group) > 1) { <button class="btn ghost sm" (click)="workspace.open({ kind: 'compare', group: r.group! })">So sánh</button> }
        @if (r.status === 'running') {
          <button class="btn ghost sm" [class.on]="workspace.follow()" [attr.aria-pressed]="workspace.follow()" (click)="workspace.follow.set(!workspace.follow())" title="Tự mở tệp agent đang làm">Theo agent</button>
        }
      }
    </div>
    <div class="stage">
      @if (activeView(); as v) {
        @switch (v.tab.kind) {
          @case ('source') {
            <tg-source-viewer [root]="$any(v.tab).root" [path]="$any(v.tab).path" />
          }
          @case ('file') {
            @if (v.run) {
              <tg-code-editor [runId]="v.run.id" [agent]="v.run.agent" [running]="v.run.status === 'running'" [path]="$any(v.tab).path" />
            }
          }
          @case ('changes') {
            @if (v.run) {
              <tg-diff-viewer [runId]="v.run.id" [agent]="v.run.agent" [running]="v.run.status === 'running'" [suggestion]="commitSuggestion(v.run.prompt)" />
            }
          }
          @case ('compare') {
            <tg-compare [group]="$any(v.tab).group" (review)="workspace.open({ kind: 'changes', runId: $event })" />
          }
        }
      } @else {
        <div class="empty">
          <p>Chưa mở tệp nào.</p>
          <p class="dim">Chọn một tệp ở cột trái để xem, hoặc giao việc ở ô bên phải. Khi agent sửa code, tệp nó đang làm sẽ tự mở ở đây.</p>
        </div>
      }
    </div>
    <tg-terminal />
  `,
})
export class Workbench {
  protected readonly workspace = inject(WorkspaceService);
  private readonly runs = inject(RunsService);
  protected readonly key = tabKey;

  protected readonly selectedTask = computed(() => {
    const r = this.runs.selected();
    return r?.task ? r : null;
  });

  protected readonly activeView = computed(() => {
    const tab = this.workspace.active();
    if (!tab) return null;
    const run = tab.kind === 'file' || tab.kind === 'changes' ? (this.runs.runs().find((r) => r.id === tab.runId) ?? null) : null;
    return { tab, run };
  });

  constructor() {
    // Keep the selected task's files and diffs fresh: on selection, on status change,
    // and whenever one of its tool calls finishes writing.
    // A question changes nothing, so it has nothing to load. While the agent edits, reloads are
    // batched (git on a large repository is not free); a finished turn reloads at once.
    let timer: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const r = this.selectedTask();
      if (!r || r.perm === 'read') return;
      const running = r.status === 'running';
      r.task;
      const a = this.runs.activity()[r.id];
      if (a && !(a.editing && a.done)) return;
      untracked(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void this.workspace.refresh(r.id);
        }, running ? REFRESH_BATCH_MS : 0);
      });
    });
    // Follow the agent: open the file it touches, if the user has not opted out.
    effect(() => {
      const r = this.selectedTask();
      const a = r ? this.runs.activity()[r.id] : null;
      if (!r || !a || r.status !== 'running' || !this.workspace.follow()) return;
      untracked(() => {
        const rel = this.workspace.relative(r.id, a.path);
        if (rel) this.workspace.openFile(r.id, rel, true);
      });
    });
    // A task that finished with changes opens its first changed file once.
    const opened = new Set<string>();
    effect(() => {
      const r = this.selectedTask();
      const diffs = r ? this.workspace.diffs()[r.id] : undefined;
      if (!r || !diffs?.length || opened.has(r.id)) return;
      opened.add(r.id);
      untracked(() => {
        if (this.workspace.tabs().some((t) => (t.kind === 'file' || t.kind === 'changes') && t.runId === r.id)) return;
        const first = diffs.find((f) => f.status !== 'D' && !f.binary);
        if (first) this.workspace.openFile(r.id, first.path);
      });
    });
    // Runs whose worktree was dropped close their tabs.
    effect(() => {
      const gone = this.runs.runs().filter((r) => !r.task).map((r) => r.id);
      untracked(() => gone.forEach((id) => this.workspace.closeRun(id)));
    });
  }

  /** First line of the request, as a commit subject. */
  protected commitSuggestion(prompt: string): string {
    const line = prompt.trim().split('\n')[0].trim();
    return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
  }

  protected title(t: Tab): string {
    if (t.kind === 'file' || t.kind === 'source') return t.path.split('/').pop() ?? t.path;
    if (t.kind === 'changes') return this.runs.runs().find((r) => r.id === t.runId)?.prompt || 'task';
    return this.runs.groupRuns(t.group)[0]?.prompt || 'nhóm';
  }

  protected tooltip(t: Tab): string {
    const preview = tabKey(t) === this.workspace.previewKey() ? '\nXem trước: bấm đúp để giữ tab' : '';
    if (t.kind === 'source') return `${t.path}\nChỉ đọc${preview}`;
    const prompt = t.kind === 'compare' ? this.runs.groupRuns(t.group)[0]?.prompt : this.runs.runs().find((r) => r.id === t.runId)?.prompt;
    return [t.kind === 'file' ? t.path : null, prompt ? `Task: ${prompt}` : null].filter(Boolean).join('\n') + preview;
  }

  protected colorOf(t: Tab): string | null {
    if (t.kind === 'compare' || t.kind === 'source') return null;
    const r = this.runs.runs().find((x) => x.id === t.runId);
    return r ? AGENT_META[r.agent].color : null;
  }

  protected pendingIn(t: Tab): boolean {
    return t.kind === 'file' && !!(this.workspace.diffs()[t.runId] ?? []).some((f) => f.path === t.path && f.hunks.length);
  }

  protected groupSize(group: string | null): number {
    return this.runs.groupRuns(group).length;
  }

  protected selectRunOf(t: Tab): void {
    if ((t.kind === 'file' || t.kind === 'changes') && this.runs.selectedId() !== t.runId) this.runs.selectedId.set(t.runId);
  }
}
