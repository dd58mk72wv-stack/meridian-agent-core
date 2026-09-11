/**
 * The integration seam.
 *
 * Every client already runs something — Dentally or SOE for a dental practice,
 * RxWorks or ProVet for a vet, Keyloop or Pinewood for a dealership — and none
 * of them will be replaced to accommodate this. So the agents are written
 * against these interfaces and never against a vendor.
 *
 * Three deliberate choices.
 *
 * SMALL INTERFACES, NOT ONE BIG ONE. A dealership's DMS has stock and no
 * treatment plans; a dental PMS has the reverse. One combined interface would
 * force every adapter to implement methods that make no sense for it and then
 * throw — which pushes the failure to runtime, on a call.
 *
 * CAPABILITIES ARE DECLARED. An adapter says what it can do before it is asked.
 * A practice management system with no write access is common, and an agent
 * that discovers this halfway through booking has already told a caller the
 * appointment is made.
 *
 * NOTHING RETURNS A VENDOR SHAPE. The adapter translates. The moment a vendor's
 * JSON reaches an agent, swapping the vendor stops being possible.
 */

/** A person or organisation the client deals with. */
export interface CustomerRecord {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  /**
   * Whatever the client's system calls its own subject — a pet, a vehicle, a
   * patient's treatment plan. Deliberately opaque here: the shared core has no
   * business knowing what a microchip number is.
   */
  subjects?: { id: string; label: string; detail?: Record<string, unknown> }[];
}

export interface AppointmentSlot {
  start: Date;
  end: Date;
  /** Resource the slot belongs to — a surgery room, a vet, a ramp. */
  resourceId?: string;
}

export interface Appointment extends AppointmentSlot {
  id: string;
  customerId: string;
  subjectId?: string;
  kind: string;
  status: 'booked' | 'cancelled' | 'completed' | 'no_show';
  notes?: string;
}

/** What an adapter can actually do. Asked before it is relied on. */
export interface Capabilities {
  readCustomers: boolean;
  writeCustomers: boolean;
  readAppointments: boolean;
  writeAppointments: boolean;
  readCatalogue: boolean;
}

export interface RecordsAdapter {
  /** For logs and the health view: which system is behind this. */
  readonly name: string;
  capabilities: () => Capabilities;

  findCustomer: (query: { phone?: string; email?: string; name?: string })
    => Promise<CustomerRecord | null>;
  createCustomer?: (input: Omit<CustomerRecord, 'id'>) => Promise<CustomerRecord>;
}

export interface SchedulingAdapter {
  readonly name: string;
  capabilities: () => Capabilities;

  availableSlots: (input: { kind: string; from: Date; to: Date; limit?: number })
    => Promise<AppointmentSlot[]>;
  book: (input: {
    customerId: string;
    subjectId?: string;
    kind: string;
    start: Date;
    notes?: string;
  }) => Promise<Appointment>;
  cancel?: (appointmentId: string, reason?: string) => Promise<void>;
  reschedule?: (appointmentId: string, start: Date) => Promise<Appointment>;
  /** Slots that freed up, for the waiting-list agent to fill. */
  cancellations?: (since: Date) => Promise<Appointment[]>;
}

/** What the client sells or offers, and what it costs. */
export interface CatalogueItem {
  id: string;
  label: string;
  /** In pence. Money is never a float. */
  pricePence?: number;
  available?: boolean;
  detail?: Record<string, unknown>;
}

export interface CatalogueAdapter {
  readonly name: string;
  search: (query: string) => Promise<CatalogueItem[]>;
  get: (id: string) => Promise<CatalogueItem | null>;
}

export interface MessagingAdapter {
  readonly name: string;
  sendSms: (to: string, body: string) => Promise<boolean>;
  sendEmail: (to: string, subject: string, body: string) => Promise<boolean>;
}

export interface PaymentAdapter {
  readonly name: string;
  /**
   * A link the customer follows to pay. Deliberately NOT "take a payment".
   *
   * No agent in this system ever handles a card number. A voice agent reading
   * back a PAN is a PCI problem that no amount of care makes acceptable, and
   * the call is being recorded.
   */
  createPaymentLink: (input: {
    customerId: string;
    amountPence: number;
    description: string;
    reference?: string;
  }) => Promise<{ url: string; reference: string }>;
  status?: (reference: string) => Promise<'pending' | 'paid' | 'failed' | 'cancelled'>;
}

/** The client's own facts: hours, location, what they offer, prices. */
export interface KnowledgeAdapter {
  readonly name: string;
  /**
   * Answer from the client's own material, or return null.
   *
   * Null is a real answer and the important one. An agent that cannot find the
   * opening hours must say it does not know rather than produce plausible
   * hours, because a caller will drive there.
   */
  lookup: (question: string) => Promise<{ answer: string; source: string } | null>;
}

export interface Adapters {
  records: RecordsAdapter;
  scheduling: SchedulingAdapter;
  catalogue?: CatalogueAdapter;
  messaging: MessagingAdapter;
  payments?: PaymentAdapter;
  knowledge: KnowledgeAdapter;
}
