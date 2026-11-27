import { invoke, translateBabeldocPdf } from './backend';
import type { LocalPdf } from './document-pdf';

// One sidecar run owns both the progressive previews and the final PDF used for saving.
export class BabeldocViewer {
  private readonly job = crypto.randomUUID();
  private count = 0;
  private page = 1;
  private rotation = 0;
  private source?: HTMLCanvasElement;
  private revision = 0;
  private displayedPage = 0;
  private closed = false;
  private stopped = false;
  private native = false;
  private timer?: number;
  private final?: LocalPdf;
  private task: Promise<void>;
  private phase: 'translating' | 'done' | 'failed' = 'translating';
  private failure = '';

  constructor(data: ArrayBuffer, target: string, private total: number,
    private stage: HTMLElement, private label: HTMLElement, private changed: () => void) {
    this.task = this.translate(data, target);
  }

  get running(): boolean { return this.phase === 'translating'; }
  get ready(): boolean { return this.phase === 'done'; }
  get status(): string {
    return this.ready ? '全ページの翻訳が完了しました' : !this.running ? this.failure : `BabelDOCで翻訳中… ${this.count} / ${this.total} ページ完了`;
  }

  private async translate(data: ArrayBuffer, target: string): Promise<void> {
    try {
      this.native = true;
      void this.poll();
      await translateBabeldocPdf(data, target, this.job);
      this.native = false;
      if (this.closed || this.stopped) return;
      const { LocalPdf } = await import('./document-pdf');
      const bytes = await invoke<ArrayBuffer>('read_babeldoc_pdf', { job: this.job, page: 0 });
      if (this.closed || this.stopped) return;
      this.final = new LocalPdf(bytes);
      if (await this.final.count() !== this.total) throw new Error('出力PDFのページ数が原本と一致しません。');
      this.phase = 'done';
    } catch (error) {
      this.failure = String(error).replace(/^Error: /, '');
    } finally {
      this.native = false;
      if (!this.ready) this.phase = 'failed';
      if (this.stopped) this.failure = '翻訳を中止しました';
      if (!this.closed) { this.changed(); void this.render(); }
      window.clearTimeout(this.timer);
    }
  }

  private async poll(): Promise<void> {
    try {
      const count = await invoke<number>('babeldoc_progress', { job: this.job, after: this.count });
      if (this.closed || !this.running) return;
      if (count > this.count) {
        const previous = this.count;
        this.count = Math.min(count, this.total);
        this.changed();
        if (this.page > previous) void this.render();
      }
    } catch { /* The first poll may arrive before the native job is registered. */ }
    if (!this.closed && this.running) this.timer = window.setTimeout(() => void this.poll(), 400);
  }

  showPage(page: number, rotation: number, source?: HTMLCanvasElement): void {
    this.page = page; this.rotation = rotation; this.source = source;
    void this.render();
  }

  private async render(): Promise<void> {
    const revision = ++this.revision;
    const current = () => !this.closed && revision === this.revision;
    const page = this.page;
    if (page !== this.displayedPage) { this.stage.replaceChildren(); this.displayedPage = page; }
    if (!this.ready && page > this.count) {
      const state = this.running && page === this.count + 1 ? '翻訳中' : '未訳';
      this.label.textContent = `${page} ページ · ${state}${this.source ? '（原本を仮表示）' : ''}`;
      if (this.source) {
        const copy = document.createElement('canvas'); copy.width = this.source.width; copy.height = this.source.height;
        copy.getContext('2d')?.drawImage(this.source, 0, 0); this.stage.replaceChildren(copy);
      }
      return;
    }
    let preview: LocalPdf | undefined;
    try {
      const canvas = document.createElement('canvas');
      this.label.textContent = `${page} ページ · 訳文を表示中…`;
      let pdf = this.ready ? this.final : undefined;
      if (!pdf) {
        const bytes = await invoke<ArrayBuffer>('read_babeldoc_pdf', { job: this.job, page });
        if (!current()) return;
        const { LocalPdf } = await import('./document-pdf');
        if (!current()) return;
        pdf = preview = new LocalPdf(bytes);
      }
      await pdf.page(preview ? 1 : page, canvas, this.rotation, false);
      if (current()) { this.stage.replaceChildren(canvas); this.label.textContent = `${page} ページ · ${preview ? '訳済み' : '完成PDF'}`; }
    } catch (error) {
      if (current()) this.label.textContent = `訳文を表示できません: ${error}`;
    } finally { await preview?.destroy().catch(() => {}); }
  }

  async save(): Promise<string | null> {
    if (!this.ready) throw new Error('翻訳中です。');
    return invoke('save_babeldoc_pdf', { job: this.job });
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.stopped = true;
      if (this.native) await invoke('cancel_operation').catch(() => {});
    }
    await this.task;
  }

  async close(): Promise<void> {
    this.closed = true; window.clearTimeout(this.timer);
    await this.stop();
    await this.final?.destroy().catch(() => {});
    await invoke('release_babeldoc_pdf', { job: this.job }).catch(() => {});
  }
}
