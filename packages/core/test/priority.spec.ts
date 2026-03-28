import assert from 'node:assert/strict'
import {
  SCOMP_DEFAULT_OPERATION_PRIORITIES,
  normalizeScompPriority,
  resolveScompPriority,
  type ScompPriorityResolutionContext
} from '../src'

describe('priority policy resolution', () => {
  it('normalizes accepted priority inputs', () => {
    assert.equal(normalizeScompPriority('P0'), 'P0')
    assert.equal(normalizeScompPriority('p1'), 'P1')
    assert.equal(normalizeScompPriority('2'), 'P2')
    assert.equal(normalizeScompPriority(3), 'P3')
    assert.equal(normalizeScompPriority('P4'), 'P4')
  })

  it('returns undefined for invalid priority inputs', () => {
    assert.equal(normalizeScompPriority(undefined), undefined)
    assert.equal(normalizeScompPriority(null), undefined)
    assert.equal(normalizeScompPriority('P8'), undefined)
    assert.equal(normalizeScompPriority('high'), undefined)
    assert.equal(normalizeScompPriority(9), undefined)
  })

  it('uses route override before metadata and operation defaults', () => {
    const decision = resolveScompPriority(
      {
        route: 'users.get',
        operation: 'request',
        meta: {
          priority: 'P3'
        }
      },
      {
        routeOverrides: {
          'users.get': 'P0'
        }
      }
    )

    assert.equal(decision.source, 'route_override')
    assert.equal(decision.requested, 'P3')
    assert.equal(decision.effective, 'P0')
  })

  it('uses metadata hint when no route override exists', () => {
    const decision = resolveScompPriority({
      route: 'users.get',
      operation: 'request',
      meta: {
        tags: {
          priority: 'P1'
        }
      }
    })

    assert.equal(decision.source, 'metadata_hint')
    assert.equal(decision.requested, 'P1')
    assert.equal(decision.effective, 'P1')
  })

  it('accepts typed metadata priorityClass and deadline hints without breaking resolution', () => {
    const decision = resolveScompPriority({
      route: 'users.get',
      operation: 'request',
      meta: {
        priorityClass: 'P0',
        deadlineAtMs: Date.now() + 1_000,
        targetLatencyMs: 25
      }
    })

    assert.equal(decision.source, 'metadata_hint')
    assert.equal(decision.requested, 'P0')
    assert.equal(decision.effective, 'P0')
  })

  it('disables metadata hints when policy forbids them', () => {
    const decision = resolveScompPriority(
      {
        route: 'users.get',
        operation: 'request',
        meta: {
          priority: 'P0'
        }
      },
      {
        allowMetadataHint: false
      }
    )

    assert.equal(decision.source, 'operation_default')
    assert.equal(decision.requested, undefined)
    assert.equal(decision.effective, 'P2')
  })

  it('uses operation defaults when no higher-precedence value is present', () => {
    const requestDecision = resolveScompPriority({
      route: 'users.get',
      operation: 'request'
    })
    const signalDecision = resolveScompPriority({
      route: 'users.notify',
      operation: 'signal'
    })

    assert.equal(requestDecision.effective, SCOMP_DEFAULT_OPERATION_PRIORITIES.request)
    assert.equal(signalDecision.effective, SCOMP_DEFAULT_OPERATION_PRIORITIES.signal)
    assert.equal(requestDecision.source, 'operation_default')
    assert.equal(signalDecision.source, 'operation_default')
  })

  it('falls back to P2 when no valid defaults are available', () => {
    const decision = resolveScompPriority(
      {
        route: 'users.get',
        operation: 'request'
      },
      {
        operationDefaults: {
          request: 'invalid' as unknown as 'P0'
        },
        defaultPriority: 'invalid' as unknown as 'P2'
      }
    )

    assert.equal(decision.source, 'operation_default')
    assert.equal(decision.effective, 'P2')
  })

  it('applies configured bounds to clamp effective priority', () => {
    const highClamped = resolveScompPriority(
      {
        route: 'users.get',
        operation: 'request',
        meta: {
          priority: 'P0'
        }
      },
      {
        bounds: {
          highest: 'P1',
          lowest: 'P3'
        }
      }
    )

    const lowClamped = resolveScompPriority(
      {
        route: 'users.get',
        operation: 'request',
        meta: {
          priority: 'P4'
        }
      },
      {
        bounds: {
          highest: 'P1',
          lowest: 'P3'
        }
      }
    )

    assert.equal(highClamped.effective, 'P1')
    assert.equal(lowClamped.effective, 'P3')
  })

  it('supports dynamic route overrides and metadata selectors', () => {
    const decision = resolveScompPriority(
      {
        route: 'feeds.live',
        operation: 'feed_start',
        meta: {
          tags: {
            qos: 'P3'
          }
        }
      },
      {
        metadataHintSelector: ({ meta }) => meta?.tags?.qos,
        routeOverrides: {
          'feeds.live': (context: ScompPriorityResolutionContext) =>
            context.operation === 'feed_start' ? 'P1' : 'P2'
        }
      }
    )

    assert.equal(decision.source, 'route_override')
    assert.equal(decision.requested, 'P3')
    assert.equal(decision.effective, 'P1')
  })
})
