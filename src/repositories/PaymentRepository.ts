import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import type { PaymentStatus } from "@/entities/Payment";
import { Payment } from "@/entities/Payment";

export class PaymentRepository {
  private getRepo(manager?: EntityManager): Repository<Payment> {
    return manager ? manager.getRepository(Payment) : AppDataSource.getRepository(Payment);
  }

  async create(
    data: {
      companyId: string;
      planId: string;
      paypalOrderId: string;
      status: PaymentStatus;
      amount: number;
      currency: string;
    },
    manager?: EntityManager,
  ): Promise<Payment> {
    const repo = this.getRepo(manager);
    return repo.save(
      repo.create({
        company: { id: data.companyId } as never,
        plan: { id: data.planId } as never,
        paypalOrderId: data.paypalOrderId,
        status: data.status,
        amount: String(data.amount),
        currency: data.currency,
        capturedAt: null,
        subscriptionStartsAt: null,
        subscriptionEndsAt: null,
        paypalResponse: null,
      }),
    );
  }

  async findByPaypalOrderId(orderId: string, manager?: EntityManager): Promise<Payment | null> {
    return this.getRepo(manager).findOne({
      where: { paypalOrderId: orderId },
      relations: ["company", "plan"],
    });
  }

  async findByPaypalOrderIdForUpdate(
    orderId: string,
    manager: EntityManager,
  ): Promise<Payment | null> {
    // Lock ONLY the payments row (`FOR UPDATE OF p`). Postgres rejects `FOR UPDATE`
    // on the nullable side of a LEFT JOIN, so we must scope the lock to "p" while
    // still eager-loading company + plan for the capture logic.
    return manager
      .getRepository(Payment)
      .createQueryBuilder("p")
      .setLock("pessimistic_write", undefined, ["p"])
      .leftJoinAndSelect("p.company", "company")
      .leftJoinAndSelect("p.plan", "plan")
      .where("p.paypalOrderId = :orderId", { orderId })
      .getOne();
  }

  async updateCaptured(
    id: string,
    data: {
      status: PaymentStatus;
      capturedAt: Date;
      subscriptionStartsAt: Date;
      subscriptionEndsAt: Date;
      paypalResponse: Record<string, unknown>;
    },
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(id, {
      status: data.status,
      capturedAt: data.capturedAt,
      subscriptionStartsAt: data.subscriptionStartsAt,
      subscriptionEndsAt: data.subscriptionEndsAt,
      paypalResponse: data.paypalResponse as never,
    });
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    paypalResponse?: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(id, {
      status,
      ...(paypalResponse ? { paypalResponse: paypalResponse as never } : {}),
    });
  }

  async findByCompany(companyId: string, manager?: EntityManager): Promise<Payment[]> {
    return this.getRepo(manager).find({
      where: { company: { id: companyId } },
      relations: ["plan"],
      order: { createdAt: "DESC" },
    });
  }
}
