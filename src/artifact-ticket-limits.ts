export type ArtifactTicketLimitReason = 'global' | 'agent';

export function isArtifactUploadReservationExpired(deadline: number | null | undefined, now = Date.now()): boolean {
  return !Number.isFinite(deadline) || Number(deadline) <= now;
}

export type ArtifactUploadReservationTicket = {
  token: string;
  kind: 'upload' | 'download';
  artifact_id: string;
  expires_at: number;
  state: 'issued' | 'reserved';
  reservation_id: string | null;
  reservation_expires_at: number | null;
};

export type ArtifactUploadReservation<TTicket extends ArtifactUploadReservationTicket = ArtifactUploadReservationTicket> = {
  ticket: TTicket;
  reservation_id: string;
};

export type ArtifactUploadReservationReleaseResult = 'released' | 'expired' | 'stale';

export class ArtifactUploadReservationManager<TTicket extends ArtifactUploadReservationTicket> {
  constructor(
    private readonly tickets: Map<string, TTicket>,
    private readonly deleteTicket: (token: string) => boolean,
    private readonly reservationTtlMs: number,
    private readonly createReservationId: () => string,
  ) {}

  reserve(token: string, artifactId: string, now = Date.now()): ArtifactUploadReservation<TTicket> | null {
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.kind !== 'upload' || ticket.artifact_id !== artifactId) return null;
    if (ticket.expires_at <= now) {
      this.deleteTicket(token);
      return null;
    }
    if (ticket.state === 'reserved') {
      // A lease deadline is a terminal boundary. Reissuing here would allow the old HTTP
      // request and a retry to use the same one-time ticket concurrently.
      if (isArtifactUploadReservationExpired(ticket.reservation_expires_at, now)) {
        this.deleteTicket(token);
      }
      return null;
    }

    ticket.state = 'reserved';
    ticket.reservation_id = this.createReservationId();
    ticket.reservation_expires_at = Math.min(ticket.expires_at, now + this.reservationTtlMs);
    return { ticket, reservation_id: ticket.reservation_id };
  }

  release(
    reservation: ArtifactUploadReservation<TTicket> | undefined,
    now = Date.now(),
  ): ArtifactUploadReservationReleaseResult {
    if (!reservation) return 'stale';
    const current = this.getCurrentReservation(reservation);
    if (!current) return 'stale';
    if (isArtifactUploadReservationExpired(current.reservation_expires_at, now)) {
      this.deleteTicket(current.token);
      return 'expired';
    }

    current.state = 'issued';
    current.reservation_id = null;
    current.reservation_expires_at = null;
    return 'released';
  }

  commit(reservation: ArtifactUploadReservation<TTicket>, now = Date.now()): boolean {
    const current = this.getCurrentReservation(reservation);
    if (!current) return false;
    if (isArtifactUploadReservationExpired(current.reservation_expires_at, now)) {
      this.deleteTicket(current.token);
      return false;
    }
    return this.deleteTicket(current.token);
  }

  consumeExpired(now = Date.now()): number {
    let consumed = 0;
    for (const [token, ticket] of this.tickets.entries()) {
      if (
        ticket.kind === 'upload'
        && ticket.state === 'reserved'
        && isArtifactUploadReservationExpired(ticket.reservation_expires_at, now)
        && this.deleteTicket(token)
      ) {
        consumed += 1;
      }
    }
    return consumed;
  }

  private getCurrentReservation(reservation: ArtifactUploadReservation<TTicket>): TTicket | null {
    const current = this.tickets.get(reservation.ticket.token);
    if (
      current !== reservation.ticket
      || current.state !== 'reserved'
      || current.reservation_id !== reservation.reservation_id
    ) {
      return null;
    }
    return current;
  }
}

class ArtifactTicketCapacityError extends Error {
  readonly reason: ArtifactTicketLimitReason;

  constructor(name: string, kind: 'upload' | 'download', reason: ArtifactTicketLimitReason) {
    super(reason === 'global'
      ? `Server has reached the active artifact ${kind} ticket limit`
      : `Agent has reached the active artifact ${kind} ticket limit`);
    this.name = name;
    this.reason = reason;
  }
}

export class ArtifactUploadTicketCapacityError extends ArtifactTicketCapacityError {
  constructor(reason: ArtifactTicketLimitReason) {
    super('ArtifactUploadTicketCapacityError', 'upload', reason);
  }
}

export class ArtifactDownloadTicketCapacityError extends ArtifactTicketCapacityError {
  constructor(reason: ArtifactTicketLimitReason) {
    super('ArtifactDownloadTicketCapacityError', 'download', reason);
  }
}

class ActiveArtifactTicketLimiter {
  private active = 0;
  private readonly activeByAgent = new Map<string, number>();

  constructor(
    readonly maxActive: number,
    readonly maxPerAgent: number,
    private readonly capacityError: (reason: ArtifactTicketLimitReason) => Error,
  ) {}

  acquire(agentId: string): void {
    if (this.active >= this.maxActive) {
      throw this.capacityError('global');
    }
    const agentActive = this.activeByAgent.get(agentId) || 0;
    if (agentActive >= this.maxPerAgent) {
      throw this.capacityError('agent');
    }
    this.active += 1;
    this.activeByAgent.set(agentId, agentActive + 1);
  }

  release(agentId: string): void {
    const agentActive = this.activeByAgent.get(agentId) || 0;
    if (agentActive <= 0) return;
    this.active = Math.max(0, this.active - 1);
    if (agentActive === 1) {
      this.activeByAgent.delete(agentId);
      return;
    }
    this.activeByAgent.set(agentId, agentActive - 1);
  }

  snapshot() {
    return {
      active: this.active,
      tracked_agents: this.activeByAgent.size,
      max_active: this.maxActive,
      max_per_agent: this.maxPerAgent,
    };
  }
}

export class ArtifactUploadTicketLimiter extends ActiveArtifactTicketLimiter {
  constructor(maxActive: number, maxPerAgent: number) {
    super(maxActive, maxPerAgent, (reason) => new ArtifactUploadTicketCapacityError(reason));
  }
}

export class ArtifactDownloadTicketLimiter extends ActiveArtifactTicketLimiter {
  constructor(maxActive: number, maxPerAgent: number) {
    super(maxActive, maxPerAgent, (reason) => new ArtifactDownloadTicketCapacityError(reason));
  }
}
