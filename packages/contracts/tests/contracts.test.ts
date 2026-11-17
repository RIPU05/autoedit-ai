import { describe, it, expect } from 'vitest';
import {
  CURRENT_CONTRACT_VERSION,
  SchemaVersionSchema,
  ApiErrorResponseSchema,
  MediaSourceSchema,
  MediaSegmentSchema,
  MediaDiscontinuitySchema,
  MediaTimeRangeSchema,
  createMediaTimeRange,
  ProjectStatusSchema,
  EditOperationSchema,
  LegacyTimelineOpSchema,
  legacyOpToEditOperation,
  editOperationToLegacyOp,
  editOperationToLegacyOpOrThrow,
  editOperationsToLegacyOps,
  UnsupportedTimelineOperationError,
  EditTimelinePlanSchema,
  EditChangeSchema,
  VersionDiffSchema,
  LiveSessionSchema,
  ReconnectionEventSchema,
  StreamHealthEventSchema,
  NormalizedChatEventSchema,
  HighlightCandidateSchema,
  HighlightSignalSchema,
  AiAnalysisResultSchema,
  TranscriptCueSchema,
  TranscriptionResultSchema,
  ProcessingJobSchema,
  ProcessingJobQueueSchema,
  JobFailureCategorySchema,
  AnalysisJobPayloadSchema,
  RenderJobPayloadSchema,
  RetentionPolicySchema,
  SegmentPinReferenceSchema,
  safeValidateContract,
  validateContract,
} from '../src/index.js';

describe('AutoAI Edit Shared Contracts Suite', () => {
  const validTenantId = 'usr_tenant_12345';
  const nowIso = new Date().toISOString();

  // 1. Valid and Invalid Payloads
  describe('1. Valid and Invalid Payloads', () => {
    it('validates a complete, valid MediaSource payload', () => {
      const payload = {
        id: 'src_rec_001',
        tenantId: validTenantId,
        projectId: 'proj_001',
        kind: 'DIRECT_UPLOAD',
        status: 'READY',
        sourceUrl: 's3://autoedit-uploads/users/usr_tenant_12345/video.mp4',
        durationMs: 3600000,
        metadata: {
          width: 1920,
          height: 1080,
          fps: 60,
          hasAudio: true,
          bitrateBps: 6000000,
        },
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const result = safeValidateContract(MediaSourceSchema, payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('src_rec_001');
        expect(result.data.kind).toBe('DIRECT_UPLOAD');
      }
    });

    it('rejects an invalid MediaSource with illegal kind', () => {
      const payload = {
        id: 'src_rec_002',
        tenantId: validTenantId,
        kind: 'INVALID_KIND', // illegal
        status: 'READY',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const result = safeValidateContract(MediaSourceSchema, payload);
      expect(result.success).toBe(false);
    });
  });

  // 2. Timestamp Ordering
  describe('2. Timestamp Ordering Enforcement', () => {
    it('accepts chronological time ranges where endMs >= startMs', () => {
      const range = {
        startMs: 12000,
        endMs: 24000,
        durationMs: 12000,
      };
      const result = safeValidateContract(MediaTimeRangeSchema, range);
      expect(result.success).toBe(true);
    });

    it('rejects reversed time ranges where endMs < startMs', () => {
      const invertedRange = {
        startMs: 30000,
        endMs: 10000,
        durationMs: -20000,
      };
      const result = safeValidateContract(MediaTimeRangeSchema, invertedRange);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('endMs'))).toBe(true);
      }
    });

    it('createMediaTimeRange helper calculates correct duration and throws on inverted timestamps', () => {
      const valid = createMediaTimeRange(1500, 4500);
      expect(valid.durationMs).toBe(3000);

      expect(() => createMediaTimeRange(5000, 2000)).toThrow(/cannot be less than startMs/);
    });
  });

  // 3. Negative Durations Rejection
  describe('3. Negative Durations and Numbers Rejection', () => {
    it('rejects negative segment duration', () => {
      const segment = {
        id: 'seg_001',
        sourceId: 'src_001',
        tenantId: validTenantId,
        sequenceNumber: 1,
        epochStartMs: 6000,
        durationMs: -6000, // illegal negative
        s3Key: 'chunks/src_001/00001.ts',
        pinReferenceCount: 0,
        retentionState: 'EPHEMERAL',
        hasDiscontinuity: false,
        createdAt: nowIso,
      };
      const result = safeValidateContract(MediaSegmentSchema, segment);
      expect(result.success).toBe(false);
    });

    it('rejects negative sequence numbers', () => {
      const segment = {
        id: 'seg_002',
        sourceId: 'src_001',
        tenantId: validTenantId,
        sequenceNumber: -1, // illegal
        epochStartMs: 0,
        durationMs: 6000,
        s3Key: 'chunks/src_001/00000.ts',
        createdAt: nowIso,
      };
      const result = safeValidateContract(MediaSegmentSchema, segment);
      expect(result.success).toBe(false);
    });
  });

  // 4. Stream Reconnection Boundaries
  describe('4. Stream Reconnection Boundaries', () => {
    it('validates a valid reconnection event with positive downtime', () => {
      const event = {
        sessionId: 'sess_live_123',
        disconnectedAtMs: 100000,
        reconnectedAtMs: 118000,
        downtimeMs: 18000,
        sequenceDiscontinuity: true,
      };

      const result = safeValidateContract(ReconnectionEventSchema, event);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.downtimeMs).toBe(18000);
        expect(result.data.sequenceDiscontinuity).toBe(true);
      }
    });

    it('rejects inverted reconnection event where reconnected is earlier than disconnected', () => {
      const event = {
        sessionId: 'sess_live_124',
        disconnectedAtMs: 120000,
        reconnectedAtMs: 100000, // impossible time travel
        downtimeMs: -20000,
        sequenceDiscontinuity: false,
      };

      const result = safeValidateContract(ReconnectionEventSchema, event);
      expect(result.success).toBe(false);
    });
  });

  // 5. Stream Health Constraints
  describe('5. Stream Health Constraints', () => {
    it('accepts valid audio dBFS negative level and positive FPS', () => {
      const health = {
        sessionId: 'sess_live_001',
        timestampMs: 45000,
        bitrateBps: 4500000,
        fps: 60.0,
        droppedFrames: 0,
        audioLevelDb: -14.2, // normal audio level below 0 dBFS
        bufferLatencyMs: 1200,
      };

      const result = safeValidateContract(StreamHealthEventSchema, health);
      expect(result.success).toBe(true);
    });

    it('rejects audio dBFS exceeding 0 dBFS clipping ceiling', () => {
      const health = {
        sessionId: 'sess_live_002',
        timestampMs: 50000,
        bitrateBps: 4500000,
        fps: 60,
        droppedFrames: 0,
        audioLevelDb: 2.5, // illegal positive dBFS
        bufferLatencyMs: 1000,
      };

      const result = safeValidateContract(StreamHealthEventSchema, health);
      expect(result.success).toBe(false);
    });
  });

  // 6. Chat Emote Constraints
  describe('6. Chat Emote Constraints', () => {
    it('validates a rich chat event with badges and emotes', () => {
      const chat = {
        id: 'chat_001',
        sourceId: 'src_live_001',
        platform: 'TWITCH',
        timestampMs: 345000,
        senderId: 'usr_viewer_99',
        senderName: 'ClipsFan99',
        message: 'OMEGALUL that was insane PogChamp',
        emotes: ['OMEGALUL', 'PogChamp'],
        badges: ['subscriber/12', 'vip/1'],
        isSubscriber: true,
        isModerator: false,
      };

      const result = safeValidateContract(NormalizedChatEventSchema, chat);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emotes).toEqual(['OMEGALUL', 'PogChamp']);
        expect(result.data.isSubscriber).toBe(true);
      }
    });
  });

  // 7. Multi-Signal Highlight Scoring
  describe('7. Multi-Signal Highlight Scoring Constraints', () => {
    it('validates highlight candidate with multiple telemetry signals', () => {
      const candidate = {
        id: 'hl_cand_001',
        sourceId: 'src_live_001',
        tenantId: validTenantId,
        timeRange: createMediaTimeRange(60000, 95000),
        compositeScore: 92.5,
        hook: {
          quote: 'Wait, did that just happen?!',
          startMs: 60000,
          endMs: 63500,
          mechanism: 'verbal_cliffhanger',
        },
        reason: {
          editorialStrategy: 'High-intensity action peak with chat spike',
          viralityRationale: 'Chat velocity 4.5x above channel baseline',
        },
        signals: [
          {
            id: 'sig_001',
            sourceId: 'src_live_001',
            signalType: 'CHAT_VELOCITY',
            timestampMs: 65000,
            value: 4.5,
            normalizedScore: 0.95,
          },
          {
            id: 'sig_002',
            sourceId: 'src_live_001',
            signalType: 'AUDIO_LOUDNESS',
            timestampMs: 62000,
            value: -8.5,
            normalizedScore: 0.9,
          },
        ],
        evidence: {
          chatSurgeMultiplier: 4.5,
          peakLufs: -8.5,
          topEmotes: ['KEKW', 'PogChamp'],
        },
        status: 'PROPOSED',
        algorithmVersion: 'v1.1-multimodal',
        createdAt: nowIso,
      };

      const result = safeValidateContract(HighlightCandidateSchema, candidate);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.compositeScore).toBe(92.5);
        expect(result.data.signals.length).toBe(2);
      }
    });

    it('rejects candidate with out-of-range composite score (> 100)', () => {
      const candidate = {
        id: 'hl_cand_002',
        sourceId: 'src_live_001',
        tenantId: validTenantId,
        timeRange: createMediaTimeRange(10000, 25000),
        compositeScore: 105, // illegal > 100
        reason: { editorialStrategy: 'Test' },
        createdAt: nowIso,
      };
      const result = safeValidateContract(HighlightCandidateSchema, candidate);
      expect(result.success).toBe(false);
    });
  });

  // 8. Missing Optional Data
  describe('8. Missing Optional Data Defaults & Resilience', () => {
    it('applies defaults when optional effects and outputs are omitted from EditTimelinePlan', () => {
      const minimalTimeline = {
        projectId: 'proj_min_001',
        tenantId: validTenantId,
        operations: [
          { action: 'keep', startSec: 0, endSec: 15 },
          { action: 'cut', startSec: 15, endSec: 22, reason: 'silence' },
          { action: 'keep', startSec: 22, endSec: 60 },
        ],
      };

      const parsed = validateContract(EditTimelinePlanSchema, minimalTimeline);
      expect(parsed.outputs).toBeDefined();
      expect(parsed.outputs[0].format).toBe('reel');
      expect(parsed.outputs[0].width).toBe(1080);
      expect(parsed.outputs[0].height).toBe(1920);
      expect(parsed.effects).toEqual({});
    });
  });

  // 9. Invalid Ownership Identifiers
  describe('9. Invalid Ownership Identifiers Rejection', () => {
    it('rejects empty or whitespace-only tenantId in ProcessingJob', () => {
      const job = {
        id: 'job_001',
        tenantId: '', // invalid empty
        queue: 'analysis',
        type: 'INITIAL_ANALYSIS',
        payload: { file: 'test.mp4' },
        idempotencyKey: 'idemp_123',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const result = safeValidateContract(ProcessingJobSchema, job);
      expect(result.success).toBe(false);
    });
  });

  // 10. Serialized Contract Compatibility
  describe('10. Serialized Contract JSON Round-Trip Compatibility', () => {
    it('round-trips complex LiveSession payload through JSON serialization safely', () => {
      const session = {
        id: 'sess_prod_99',
        tenantId: validTenantId,
        sourceId: 'src_rtmp_99',
        streamKeyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        state: 'LIVE',
        protocol: 'SRT',
        startedAt: nowIso,
        pinnedSegmentsCount: 4,
        health: {
          sessionId: 'sess_prod_99',
          timestampMs: 120000,
          bitrateBps: 5500000,
          fps: 59.94,
          droppedFrames: 2,
          audioLevelDb: -12.4,
          bufferLatencyMs: 850,
        },
      };

      const jsonStr = JSON.stringify(session);
      const parsedObj = JSON.parse(jsonStr);
      const validated = validateContract(LiveSessionSchema, parsedObj);

      expect(validated.id).toBe(session.id);
      expect(validated.protocol).toBe('SRT');
      expect(validated.health?.audioLevelDb).toBe(-12.4);
    });
  });

  // 11. Retention Policy & Pin Lease Validation
  describe('11. Retention Policy & Pin Leases', () => {
    it('validates default 30-minute pilot buffer in RetentionPolicy', () => {
      const policy = {
        tenantId: validTenantId,
      };

      const validated = validateContract(RetentionPolicySchema, policy);
      expect(validated.ephemeralBufferMinutes).toBe(30); // 30-minute pilot default
      expect(validated.pinLeaseHours).toBe(72);
      expect(validated.gracePeriodHours).toBe(24);
    });

    it('validates reference-counted segment pin lease and expiration', () => {
      const pinRef = {
        pinId: 'pin_001',
        segmentId: 'seg_chunk_450',
        tenantId: validTenantId,
        referenceType: 'HIGHLIGHT_CANDIDATE',
        referenceId: 'hl_cand_001',
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      };

      const result = safeValidateContract(SegmentPinReferenceSchema, pinRef);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.referenceType).toBe('HIGHLIGHT_CANDIDATE');
        expect(result.data.expiresAt).toBeDefined();
      }
    });

    it('rejects negative or sub-minimum ephemeral buffer (< 5 minutes)', () => {
      const invalidPolicy = {
        tenantId: validTenantId,
        ephemeralBufferMinutes: 2, // below minimum 5 min
      };
      const result = safeValidateContract(RetentionPolicySchema, invalidPolicy);
      expect(result.success).toBe(false);
    });
  });

  // 12. Extended Step 3A Contracts & Adapters
  describe('12. Step 3A Extended Domain Contracts & Adapters', () => {
    it('validates CURRENT_CONTRACT_VERSION is SemVer', () => {
      expect(CURRENT_CONTRACT_VERSION).toBe('1.0.0');
      expect(safeValidateContract(SchemaVersionSchema, CURRENT_CONTRACT_VERSION).success).toBe(true);
    });

    it('validates standard ApiErrorResponse schema', () => {
      const validErr = { error: 'Invalid credentials', code: 'AUTH_FAILED', details: { attempt: 3 } };
      expect(safeValidateContract(ApiErrorResponseSchema, validErr).success).toBe(true);

      const invalidErr = { error: '' };
      expect(safeValidateContract(ApiErrorResponseSchema, invalidErr).success).toBe(false);
    });

    it('validates ProjectStatus schema matching Prisma and web', () => {
      const validStatuses = ['UPLOADING', 'UPLOADED', 'ANALYZING', 'ANALYZED', 'RENDERING', 'RENDERED', 'FAILED'];
      for (const st of validStatuses) {
        expect(safeValidateContract(ProjectStatusSchema, st).success).toBe(true);
      }
      expect(safeValidateContract(ProjectStatusSchema, 'UNKNOWN_STATUS').success).toBe(false);
    });

    describe('Timeline Conversion Adapters (Step 3A.1 Safety Hardened)', () => {
      it('converts keep operations faithfully and preserves round-trip semantics', () => {
        const canonicalKeep = {
          action: 'keep' as const,
          startSec: 0,
          endSec: 12.5,
          startMs: 0,
          endMs: 12500,
        };
        const result = editOperationToLegacyOp(canonicalKeep, 0);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.op.keep).toBe(true);
          expect(result.op.start).toBe(0);
          expect(result.op.end).toBe(12.5);
          expect(result.op.index).toBe(0);

          // Reverse conversion
          const roundTrip = legacyOpToEditOperation(result.op);
          expect(roundTrip.action).toBe('keep');
          expect(roundTrip.startSec).toBe(0);
          expect(roundTrip.endSec).toBe(12.5);
          expect(roundTrip.startMs).toBe(0);
          expect(roundTrip.endMs).toBe(12500);
        }
      });

      it('converts cut operations faithfully with reason preserved', () => {
        const canonicalCut = {
          action: 'cut' as const,
          startSec: 12.5,
          endSec: 16.0,
          reason: 'dead air / silence',
        };
        const result = editOperationToLegacyOp(canonicalCut, 1);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.op.keep).toBe(false);
          expect(result.op.cutReason).toBe('dead air / silence');
          expect(result.op.start).toBe(12.5);
          expect(result.op.end).toBe(16.0);

          // Reverse conversion
          const roundTrip = legacyOpToEditOperation(result.op);
          expect(roundTrip.action).toBe('cut');
          expect(roundTrip.startSec).toBe(12.5);
          expect(roundTrip.endSec).toBe(16.0);
          if (roundTrip.action === 'cut') {
            expect(roundTrip.reason).toBe('dead air / silence');
          }
        }
      });

      it('converts zoom operations with center pan and preserves exact scale factor', () => {
        const canonicalZoom = {
          action: 'zoom' as const,
          startSec: 5.0,
          endSec: 9.5,
          scale: 1.35,
          pan: 'center' as const,
        };
        const result = editOperationToLegacyOp(canonicalZoom, 2);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.op.keep).toBe(true);
          expect(result.op.dynamicZoom).toBe(true);
          expect(result.op.zoom).toBe(1.35); // Scale preserved! Not discarded or hardcoded
          expect(result.op.start).toBe(5.0);
          expect(result.op.end).toBe(9.5);

          // Reverse conversion preserves exact scale
          const roundTrip = legacyOpToEditOperation(result.op);
          expect(roundTrip.action).toBe('zoom');
          if (roundTrip.action === 'zoom') {
            expect(roundTrip.scale).toBe(1.35);
            expect(roundTrip.pan).toBe('center');
          }
        }
      });

      it('fails closed with explicit typed error when speed operation is converted to legacy', () => {
        const canonicalSpeed = {
          action: 'speed' as const,
          startSec: 2.0,
          endSec: 6.0,
          speedMultiplier: 2.0,
        };
        const result = editOperationToLegacyOp(canonicalSpeed, 0);
        // Must NEVER silently convert speed to keep!
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('UNSUPPORTED_OPERATION');
          expect(result.error.action).toBe('speed');
          expect(result.error.message).toContain('Legacy renderer does not support speed');
          expect(result.error.details).toEqual({ speedMultiplier: 2.0 });
        }

        // Throwing variant must throw UnsupportedTimelineOperationError
        expect(() => editOperationToLegacyOpOrThrow(canonicalSpeed, 0)).toThrow(
          UnsupportedTimelineOperationError,
        );
      });

      it('fails closed when directional zoom panning (left or right) is converted to legacy', () => {
        const canonicalLeftZoom = {
          action: 'zoom' as const,
          startSec: 1.0,
          endSec: 4.0,
          scale: 1.25,
          pan: 'left' as const,
        };
        const result = editOperationToLegacyOp(canonicalLeftZoom, 0);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe('UNSUPPORTED_PROPERTY');
          expect(result.error.action).toBe('zoom');
          expect(result.error.field).toBe('pan');
          expect(result.error.message).toContain('directional pan');
        }

        const canonicalRightZoom = {
          action: 'zoom' as const,
          startSec: 1.0,
          endSec: 4.0,
          scale: 1.25,
          pan: 'right' as const,
        };
        const resultRight = editOperationToLegacyOp(canonicalRightZoom, 0);
        expect(resultRight.success).toBe(false);
        if (!resultRight.success) {
          expect(resultRight.error.code).toBe('UNSUPPORTED_PROPERTY');
          expect(resultRight.error.field).toBe('pan');
        }
      });

      it('validates start and end time ranges and rejects invalid spans', () => {
        // Inverted time range
        const inverted = {
          action: 'keep' as const,
          startSec: 10.0,
          endSec: 5.0,
        };
        const resInverted = editOperationToLegacyOp(inverted);
        expect(resInverted.success).toBe(false);
        if (!resInverted.success) {
          expect(resInverted.error.code).toBe('INVALID_TIME_RANGE');
          expect(resInverted.error.message).toContain('startSec (10) must be strictly less than endSec (5)');
        }

        // Zero duration span
        const zeroDuration = {
          action: 'cut' as const,
          startSec: 5.0,
          endSec: 5.0,
        };
        const resZero = editOperationToLegacyOp(zeroDuration);
        expect(resZero.success).toBe(false);
        if (!resZero.success) {
          expect(resZero.error.code).toBe('INVALID_TIME_RANGE');
        }
      });

      it('preserves sub-second floating-point precision during conversion', () => {
        const preciseKeep = {
          action: 'keep' as const,
          startSec: 1.23456,
          endSec: 7.89012,
        };
        const res = editOperationToLegacyOp(preciseKeep);
        expect(res.success).toBe(true);
        if (res.success) {
          expect(res.op.start).toBe(1.23456);
          expect(res.op.end).toBe(7.89012);

          const roundTrip = legacyOpToEditOperation(res.op);
          expect(roundTrip.startSec).toBe(1.23456);
          expect(roundTrip.endSec).toBe(7.89012);
          expect(roundTrip.startMs).toBe(1235);
          expect(roundTrip.endMs).toBe(7890);
        }
      });

      it('batch converts valid timelines and reports all errors when unsupported operations exist', () => {
        const validTimeline = [
          { action: 'keep' as const, startSec: 0, endSec: 5 },
          { action: 'cut' as const, startSec: 5, endSec: 8, reason: 'um' },
          { action: 'zoom' as const, startSec: 8, endSec: 12, scale: 1.2, pan: 'center' as const },
        ];
        const validBatch = editOperationsToLegacyOps(validTimeline);
        expect(validBatch.success).toBe(true);
        if (validBatch.success) {
          expect(validBatch.ops).toHaveLength(3);
          expect(validBatch.ops[0].keep).toBe(true);
          expect(validBatch.ops[1].keep).toBe(false);
          expect(validBatch.ops[2].zoom).toBe(1.2);
        }

        const mixedTimeline = [
          { action: 'keep' as const, startSec: 0, endSec: 5 },
          { action: 'speed' as const, startSec: 5, endSec: 8, speedMultiplier: 1.5 },
          { action: 'zoom' as const, startSec: 8, endSec: 12, scale: 1.2, pan: 'left' as const },
        ];
        const mixedBatch = editOperationsToLegacyOps(mixedTimeline);
        expect(mixedBatch.success).toBe(false);
        if (!mixedBatch.success) {
          expect(mixedBatch.errors).toHaveLength(2);
          expect(mixedBatch.errors[0].code).toBe('UNSUPPORTED_OPERATION');
          expect(mixedBatch.errors[1].code).toBe('UNSUPPORTED_PROPERTY');
        }
      });
    });

    it('validates BullMQ Analysis and Render job payloads', () => {
      const validAnalysis = {
        projectId: 'proj_bull_001',
        s3Key: 'uploads/usr_1/source.mp4',
        bucket: 'autoedit-local',
        userPrompt: 'Cut dead air and zoom on punchlines',
      };
      expect(safeValidateContract(AnalysisJobPayloadSchema, validAnalysis).success).toBe(true);

      const validRender = {
        projectId: 'proj_bull_001',
        renderId: 'render_bull_001',
        format: 'reel',
      };
      expect(safeValidateContract(RenderJobPayloadSchema, validRender).success).toBe(true);

      const invalidRender = {
        projectId: 'proj_bull_001',
        renderId: 'render_bull_001',
        format: 'square_4x4', // invalid format
      };
      expect(safeValidateContract(RenderJobPayloadSchema, invalidRender).success).toBe(false);
    });

    it('validates AI analysis results and transcription with degraded status', () => {
      const aiAnalysis = {
        summary: 'Action stream highlight package',
        highlights: [
          { start: 1.5, end: 7.2, label: 'Opening hook', score: 94 },
          { start: 15.0, end: 22.8, label: 'Boss fight victory', score: 98 },
        ],
      };
      expect(safeValidateContract(AiAnalysisResultSchema, aiAnalysis).success).toBe(true);

      const degradedTranscription = {
        cues: [{ start: 0, end: 11.58, text: '[Silence fallback timeline]' }],
        text: '[Silence fallback timeline]',
        isDegraded: true,
        provider: 'fallback',
        model: 'silence-detector',
      };
      const res = safeValidateContract(TranscriptionResultSchema, degradedTranscription);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.isDegraded).toBe(true);
        expect(res.data.provider).toBe('fallback');
      }
    });

    it('validates EditChange and VersionDiff contracts', () => {
      const editChange = {
        action: 'kept',
        target: '00:00–00:15',
        reasons: ['High speech density', 'Clear intro'],
      };
      expect(safeValidateContract(EditChangeSchema, editChange).success).toBe(true);

      const versionDiff = {
        clipsAdded: ['00:15–00:30'],
        clipsRemoved: ['00:45–01:00'],
        durationChangeSec: -15,
        effectChanges: [],
        from: { id: 'v1', name: 'Original', durationSec: 60 },
        to: { id: 'v2', name: 'Edited', durationSec: 45 },
      };
      expect(safeValidateContract(VersionDiffSchema, versionDiff).success).toBe(true);
    });
  });
});
