import { describe, it, expect } from 'vitest';
import {
  MediaSourceSchema,
  MediaSegmentSchema,
  MediaDiscontinuitySchema,
  MediaTimeRangeSchema,
  createMediaTimeRange,
  LiveSessionSchema,
  ReconnectionEventSchema,
  StreamHealthEventSchema,
  NormalizedChatEventSchema,
  HighlightCandidateSchema,
  HighlightSignalSchema,
  EditTimelinePlanSchema,
  ProcessingJobSchema,
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

    it('rejects an impossible reconnection where reconnectedAt is before disconnectedAt', () => {
      const invalidEvent = {
        sessionId: 'sess_live_123',
        disconnectedAtMs: 200000,
        reconnectedAtMs: 150000, // before disconnect
        downtimeMs: -50000,
        sequenceDiscontinuity: true,
      };

      const result = safeValidateContract(ReconnectionEventSchema, invalidEvent);
      expect(result.success).toBe(false);
    });

    it('validates stream health metrics bounded within legal audio and frame limits', () => {
      const health = {
        sessionId: 'sess_live_123',
        timestampMs: 5000,
        bitrateBps: 6000000,
        fps: 60,
        droppedFrames: 0,
        audioLevelDb: -14.2, // valid <= 0 dBFS
        bufferLatencyMs: 1200,
      };
      const result = safeValidateContract(StreamHealthEventSchema, health);
      expect(result.success).toBe(true);

      // Illegal > 0 dBFS
      const illegalHealth = { ...health, audioLevelDb: 5.0 };
      expect(safeValidateContract(StreamHealthEventSchema, illegalHealth).success).toBe(false);
    });
  });

  // 5. Media Discontinuities
  describe('5. Media Discontinuity Handling', () => {
    it('validates a PTS gap discontinuity with sequence offset', () => {
      const discontinuity = {
        sequenceNumber: 122,
        epochOffsetMs: 18450,
        reason: 'OBS_SOCKET_DROP_RECONNECTED',
        timestampMs: 732000,
        clockDriftMs: 450,
      };

      const result = safeValidateContract(MediaDiscontinuitySchema, discontinuity);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reason).toBe('OBS_SOCKET_DROP_RECONNECTED');
        expect(result.data.clockDriftMs).toBe(450);
      }
    });
  });

  // 6. Chat Event Normalization
  describe('6. Chat Event Normalization Across Platforms', () => {
    it('normalizes Twitch chat message with emotes and badges', () => {
      const twitchMsg = {
        id: 'chat_tw_001',
        sourceId: 'src_live_001',
        platform: 'TWITCH',
        timestampMs: 45120,
        senderId: 'user_456',
        senderName: 'SpeedyGamer',
        message: 'OMEGALUL that was insane! KEKW',
        emotes: ['OMEGALUL', 'KEKW'],
        badges: ['subscriber', 'vip'],
        isSubscriber: true,
        isModerator: false,
      };

      const result = safeValidateContract(NormalizedChatEventSchema, twitchMsg);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe('TWITCH');
        expect(result.data.emotes).toContain('KEKW');
      }
    });

    it('normalizes YouTube and Kick events without required badges', () => {
      const ytMsg = {
        id: 'chat_yt_002',
        sourceId: 'src_live_001',
        platform: 'YOUTUBE',
        timestampMs: 46000,
        senderId: 'channel_yt_99',
        senderName: 'Viewer123',
        message: 'First time watching live!',
      };

      const result = safeValidateContract(NormalizedChatEventSchema, ytMsg);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe('YOUTUBE');
        expect(result.data.emotes).toEqual([]);
        expect(result.data.isSubscriber).toBe(false);
      }
    });
  });

  // 7. Highlight Evidence References
  describe('7. Highlight Evidence & Candidate Verification', () => {
    it('validates a complete highlight candidate proposal with evidence and signals', () => {
      const candidate = {
        id: 'hl_cand_001',
        sourceId: 'src_live_001',
        tenantId: validTenantId,
        timeRange: createMediaTimeRange(120000, 150000), // 30s duration
        compositeScore: 92.5,
        hook: {
          quote: 'I cannot believe this just worked on stream!',
          startMs: 120500,
          endMs: 123800,
          mechanism: 'SHOCK_REVELATION',
        },
        reason: {
          editorialStrategy: 'High-energy punchline following 400% chat velocity spike',
          hookMechanism: 'Contrarian surprise',
          viralityRationale: 'Top 1% emote density',
        },
        signals: [
          {
            id: 'sig_001',
            sourceId: 'src_live_001',
            signalType: 'CHAT_VELOCITY',
            timestampMs: 121000,
            value: 4.2,
            normalizedScore: 0.95,
          },
          {
            id: 'sig_002',
            sourceId: 'src_live_001',
            signalType: 'AUDIO_LOUDNESS',
            timestampMs: 122500,
            value: -8.5,
            normalizedScore: 0.88,
          },
        ],
        evidence: {
          chatSurgeMultiplier: 4.2,
          peakLufs: -8.5,
          speechWpm: 195,
          hookText: 'I cannot believe this just worked',
          silenceEliminatedSec: 3.2,
          topEmotes: ['POG', 'KEKW'],
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
});
