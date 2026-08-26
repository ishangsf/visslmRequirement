import type {
  AssistantArtifact,
  AssistantArtifactInput,
  AssistantArtifactOutputFormat
} from '../../../shared/types'
import {
  exportAssistantArtifact,
  type ArtifactExportOptions,
  type ArtifactExportOutput,
  type ArtifactExportSource
} from '../artifact-exporter'

/** Request accepted by the evidence-only delivery agent. */
export interface ArtifactAgentRequest {
  format: AssistantArtifactOutputFormat
  fileName?: string
  artifactId?: string
  instructions?: string
}

/**
 * Execution boundary for local deliverables. The agent deliberately accepts
 * only a saved AssistantArtifact or its already-verified input payload. It
 * does not own a database, knowledge service, model client, or write tool.
 */
export class ArtifactAgent {
  readonly id = 'artifact' as const
  readonly version = 'artifact-v1'

  async generate(
    source: ArtifactExportSource,
    request: ArtifactAgentRequest
  ): Promise<ArtifactExportOutput> {
    return exportAssistantArtifact(source, request)
  }

  async exportArtifact(
    source: ArtifactExportSource,
    request: ArtifactAgentRequest
  ): Promise<ArtifactExportOutput> {
    return this.generate(source, request)
  }
}

/** Alias used by orchestration code that calls the role by product name. */
export class DeliverableAgent extends ArtifactAgent {}

export const generateArtifact = (
  source: AssistantArtifact | AssistantArtifactInput,
  request: ArtifactAgentRequest
): Promise<ArtifactExportOutput> => new ArtifactAgent().generate(source, request)

export const exportArtifact = generateArtifact

/**
 * Compatibility entry point for the main-process export IPC. Generation is
 * asynchronous because DOCX and PPTX writers return promises; callers must
 * await this function before showing a save dialog or writing bytes.
 */
export const renderAssistantArtifact = (
  artifact: AssistantArtifact,
  format: AssistantArtifactOutputFormat,
  instructions?: string
): Promise<ArtifactExportOutput> => generateArtifact(artifact, { format, instructions })

export type { ArtifactExportOptions, ArtifactExportOutput, ArtifactExportSource }
