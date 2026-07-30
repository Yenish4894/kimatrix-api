import { IsNull, type EntityManager, type Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { Token } from "@/entities/Token";

export class TokenRepository {
  private getRepo(manager?: EntityManager): Repository<Token> {
    return manager ? manager.getRepository(Token) : AppDataSource.getRepository(Token);
  }

  async create(data: Partial<Token>, manager?: EntityManager): Promise<Token> {
    const repo = this.getRepo(manager);
    return repo.save(repo.create(data));
  }

  async findActiveRefreshToken(tokenHash: string, manager?: EntityManager): Promise<Token | null> {
    return this.getRepo(manager)
      .createQueryBuilder("t")
      .addSelect("t.tokenHash")
      .leftJoinAndSelect("t.user", "u")
      .where("t.tokenHash = :tokenHash", { tokenHash })
      .andWhere("t.type = :type", { type: "refresh" })
      .andWhere("t.revokedAt IS NULL")
      .andWhere("t.expiresAt > NOW()")
      .getOne();
  }

  async findRefreshTokenByHash(tokenHash: string, manager?: EntityManager): Promise<Token | null> {
    return this.getRepo(manager)
      .createQueryBuilder("t")
      .addSelect("t.tokenHash")
      .leftJoinAndSelect("t.user", "u")
      .where("t.tokenHash = :tokenHash", { tokenHash })
      .andWhere("t.type = :type", { type: "refresh" })
      .getOne();
  }

  async revokeAllRefreshTokensForUser(userId: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager)
      .createQueryBuilder()
      .update(Token)
      .set({ revokedAt: new Date() })
      .where("user_id = :userId", { userId })
      .andWhere("type = :type", { type: "refresh" })
      .andWhere("revoked_at IS NULL")
      .execute();
  }

  async findUsablePasswordResetToken(
    tokenHash: string,
    manager?: EntityManager,
  ): Promise<Token | null> {
    return this.getRepo(manager)
      .createQueryBuilder("t")
      .addSelect("t.tokenHash")
      .leftJoinAndSelect("t.user", "u")
      .where("t.tokenHash = :tokenHash", { tokenHash })
      .andWhere("t.type = :type", { type: "password_reset" })
      .andWhere("t.consumedAt IS NULL")
      .andWhere("t.expiresAt > NOW()")
      .getOne();
  }

  async findUsableEmailVerificationToken(
    tokenHash: string,
    manager?: EntityManager,
  ): Promise<Token | null> {
    return this.getRepo(manager)
      .createQueryBuilder("t")
      .addSelect("t.tokenHash")
      .leftJoinAndSelect("t.user", "u")
      .where("t.tokenHash = :tokenHash", { tokenHash })
      .andWhere("t.type = :type", { type: "email_verification" })
      .andWhere("t.consumedAt IS NULL")
      .andWhere("t.expiresAt > NOW()")
      .getOne();
  }

  async consumeEmailVerificationToken(id: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).update(
      { id, type: "email_verification", consumedAt: IsNull() },
      { consumedAt: new Date() },
    );
  }

  async invalidateActiveEmailVerifications(userId: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager)
      .createQueryBuilder()
      .update(Token)
      .set({ consumedAt: new Date() })
      .where("user_id = :userId", { userId })
      .andWhere("type = :type", { type: "email_verification" })
      .andWhere("consumed_at IS NULL")
      .execute();
  }

  async revokeRefreshToken(id: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).update(
      { id, type: "refresh", revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  async consumePasswordResetToken(id: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).update(
      { id, type: "password_reset", consumedAt: IsNull() },
      { consumedAt: new Date() },
    );
  }

  async invalidateActivePasswordResets(userId: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager)
      .createQueryBuilder()
      .update(Token)
      .set({ consumedAt: new Date() })
      .where("user_id = :userId", { userId })
      .andWhere("type = :type", { type: "password_reset" })
      .andWhere("consumed_at IS NULL")
      .execute();
  }

  async deleteTombstonedOlderThan(olderThan: Date, manager?: EntityManager): Promise<number> {
    const result = await this.getRepo(manager)
      .createQueryBuilder()
      .delete()
      .from(Token)
      .where(
        "(revoked_at IS NOT NULL OR consumed_at IS NOT NULL OR expires_at < NOW()) AND created_at < :cutoff",
        { cutoff: olderThan },
      )
      .execute();
    return result.affected ?? 0;
  }

  async listActiveRefreshTokensForUser(userId: string, manager?: EntityManager): Promise<Token[]> {
    return this.getRepo(manager)
      .createQueryBuilder("t")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.type = :type", { type: "refresh" })
      .andWhere("t.revokedAt IS NULL")
      .andWhere("t.expiresAt > :now", { now: new Date() })
      .getMany();
  }
}
