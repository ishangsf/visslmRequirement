import type { AgentEvent } from '../../shared/expert-types'

type AnswerTextEvent = Extract<AgentEvent, { type: 'text' }>

export interface AnswerStreamOptions {
  emit: (event: AnswerTextEvent) => void
  signal?: AbortSignal
}

/**
 * Owns the visible answer event contract for one assistant run. Model deltas
 * are forwarded immediately, while the final verified answer remains the
 * source of truth and is used to append or replace the live buffer.
 */
export class AnswerStream {
  private static readonly maxDeltaCodePoints = 96
  private sequence = 0
  private visibleText = ''
  private completed = false

  constructor(private readonly options: AnswerStreamOptions) {}

  push(content: string): void {
    if (this.completed || this.options.signal?.aborted || !content) return
    this.visibleText += content
    this.options.emit({
      type: 'text',
      content,
      sequence: ++this.sequence
    })
  }

  private pushInSafeChunks(content: string): void {
    if (!content) return
    const codePoints = Array.from(content)
    for (let offset = 0; offset < codePoints.length; offset += AnswerStream.maxDeltaCodePoints) {
      this.push(codePoints.slice(offset, offset + AnswerStream.maxDeltaCodePoints).join(''))
    }
  }

  /**
   * Complete only after the caller has validated the authoritative answer.
   * If a model stream diverged from that answer, a replacement event prevents
   * the renderer from retaining unverified text.
   */
  complete(answer: string): void {
    if (this.completed || this.options.signal?.aborted) return
    const finalText = answer || ''
    if (finalText.startsWith(this.visibleText)) {
      this.pushInSafeChunks(finalText.slice(this.visibleText.length))
    } else if (finalText !== this.visibleText) {
      this.visibleText = finalText
      this.options.emit({
        type: 'text',
        content: finalText,
        sequence: ++this.sequence,
        replace: true,
        reset: true
      })
    }
    if (this.options.signal?.aborted) return
    this.options.emit({
      type: 'text',
      content: '',
      sequence: ++this.sequence,
      done: true
    })
    this.completed = true
  }

  /** Stop accepting late model callbacks after failure, clarification, or cancellation. */
  abandon(): void {
    this.completed = true
  }

  get text(): string {
    return this.visibleText
  }
}
