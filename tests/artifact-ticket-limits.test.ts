import { describe, expect, it } from 'vitest';
import {
  ArtifactDownloadTicketCapacityError,
  ArtifactDownloadTicketLimiter,
  ArtifactUploadReservationManager,
  type ArtifactUploadReservationTicket,
  ArtifactUploadTicketCapacityError,
  ArtifactUploadTicketLimiter,
  isArtifactUploadReservationExpired,
} from '../src/artifact-ticket-limits.js';

describe('ArtifactUploadTicketLimiter', () => {
  it('enforces per-agent and global active ticket limits and releases capacity', () => {
    const limiter = new ArtifactUploadTicketLimiter(3, 2);

    limiter.acquire('agent-a');
    limiter.acquire('agent-a');
    expect(() => limiter.acquire('agent-a')).toThrowError(
      expect.objectContaining<Partial<ArtifactUploadTicketCapacityError>>({ reason: 'agent' }),
    );

    limiter.acquire('agent-b');
    expect(() => limiter.acquire('agent-c')).toThrowError(
      expect.objectContaining<Partial<ArtifactUploadTicketCapacityError>>({ reason: 'global' }),
    );
    expect(limiter.snapshot()).toEqual({
      active: 3,
      tracked_agents: 2,
      max_active: 3,
      max_per_agent: 2,
    });

    limiter.release('agent-a');
    limiter.acquire('agent-c');
    limiter.release('missing-agent');
    expect(limiter.snapshot()).toEqual({
      active: 3,
      tracked_agents: 3,
      max_active: 3,
      max_per_agent: 2,
    });
  });

  it('applies the same accounting contract to download tickets', () => {
    const limiter = new ArtifactDownloadTicketLimiter(2, 1);
    limiter.acquire('agent-a');
    expect(() => limiter.acquire('agent-a')).toThrowError(
      expect.objectContaining<Partial<ArtifactDownloadTicketCapacityError>>({ reason: 'agent' }),
    );
    limiter.acquire('agent-b');
    expect(() => limiter.acquire('agent-c')).toThrowError(
      expect.objectContaining<Partial<ArtifactDownloadTicketCapacityError>>({ reason: 'global' }),
    );
    limiter.release('agent-a');
    limiter.acquire('agent-c');
    expect(limiter.snapshot()).toMatchObject({ active: 2, tracked_agents: 2 });
  });

  it('expires upload reservations at a bounded lease deadline', () => {
    expect(isArtifactUploadReservationExpired(10_001, 10_000)).toBe(false);
    expect(isArtifactUploadReservationExpired(10_000, 10_000)).toBe(true);
    expect(isArtifactUploadReservationExpired(null, 10_000)).toBe(true);
  });

  it('permanently consumes an expired reservation and releases limiter capacity', () => {
    const limiter = new ArtifactUploadTicketLimiter(1, 1);
    const tickets = new Map<string, ArtifactUploadReservationTicket>();
    const ticket: ArtifactUploadReservationTicket = {
      token: 'upload-token',
      kind: 'upload',
      artifact_id: 'artifact-1',
      expires_at: 20_000,
      state: 'issued',
      reservation_id: null,
      reservation_expires_at: null,
    };
    limiter.acquire('agent-a');
    tickets.set(ticket.token, ticket);
    const manager = new ArtifactUploadReservationManager(
      tickets,
      (token) => {
        if (!tickets.delete(token)) return false;
        limiter.release('agent-a');
        return true;
      },
      1_000,
      () => 'reservation-1',
    );

    expect(manager.reserve(ticket.token, ticket.artifact_id, 10_000)).toMatchObject({
      reservation_id: 'reservation-1',
    });
    expect(manager.reserve(ticket.token, ticket.artifact_id, 11_000)).toBeNull();
    expect(tickets.has(ticket.token)).toBe(false);
    expect(limiter.snapshot()).toMatchObject({ active: 0, tracked_agents: 0 });

    // The same one-time token cannot be resurrected, while its capacity is reusable.
    expect(manager.reserve(ticket.token, ticket.artifact_id, 11_001)).toBeNull();
    expect(() => limiter.acquire('agent-a')).not.toThrow();
  });

  it('keeps explicit pre-expiry release retryable but consumes leases at the deadline', () => {
    const limiter = new ArtifactUploadTicketLimiter(1, 1);
    const tickets = new Map<string, ArtifactUploadReservationTicket>();
    const ticket: ArtifactUploadReservationTicket = {
      token: 'retry-token',
      kind: 'upload',
      artifact_id: 'artifact-2',
      expires_at: 30_000,
      state: 'issued',
      reservation_id: null,
      reservation_expires_at: null,
    };
    limiter.acquire('agent-a');
    tickets.set(ticket.token, ticket);
    let reservationSequence = 0;
    const manager = new ArtifactUploadReservationManager(
      tickets,
      (token) => {
        if (!tickets.delete(token)) return false;
        limiter.release('agent-a');
        return true;
      },
      1_000,
      () => `reservation-${++reservationSequence}`,
    );

    const first = manager.reserve(ticket.token, ticket.artifact_id, 10_000);
    expect(first).not.toBeNull();
    expect(manager.release(first!, 10_999)).toBe('released');
    expect(manager.reserve(ticket.token, ticket.artifact_id, 11_000)).toMatchObject({
      reservation_id: 'reservation-2',
    });
    expect(limiter.snapshot()).toMatchObject({ active: 1, tracked_agents: 1 });

    expect(manager.consumeExpired(12_000)).toBe(1);
    expect(tickets.has(ticket.token)).toBe(false);
    expect(limiter.snapshot()).toMatchObject({ active: 0, tracked_agents: 0 });
  });

  it('rejects an expired commit without leaving a reusable ticket', () => {
    const limiter = new ArtifactUploadTicketLimiter(1, 1);
    const tickets = new Map<string, ArtifactUploadReservationTicket>();
    const ticket: ArtifactUploadReservationTicket = {
      token: 'commit-token',
      kind: 'upload',
      artifact_id: 'artifact-3',
      expires_at: 30_000,
      state: 'issued',
      reservation_id: null,
      reservation_expires_at: null,
    };
    limiter.acquire('agent-a');
    tickets.set(ticket.token, ticket);
    const manager = new ArtifactUploadReservationManager(
      tickets,
      (token) => {
        if (!tickets.delete(token)) return false;
        limiter.release('agent-a');
        return true;
      },
      1_000,
      () => 'reservation-1',
    );

    const reservation = manager.reserve(ticket.token, ticket.artifact_id, 10_000);
    expect(reservation).not.toBeNull();
    expect(manager.commit(reservation!, 11_000)).toBe(false);
    expect(tickets.has(ticket.token)).toBe(false);
    expect(limiter.snapshot()).toMatchObject({ active: 0, tracked_agents: 0 });
  });
});
