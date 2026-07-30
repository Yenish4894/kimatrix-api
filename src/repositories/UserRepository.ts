import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { User } from "@/entities/User";

export class UserRepository {
  private getRepo(manager?: EntityManager): Repository<User> {
    return manager ? manager.getRepository(User) : AppDataSource.getRepository(User);
  }

  async findByEmail(email: string, manager?: EntityManager): Promise<User | null> {
    return this.getRepo(manager).findOne({ where: { email } });
  }

  async findByEmailWithPassword(email: string, manager?: EntityManager): Promise<User | null> {
    return this.getRepo(manager)
      .createQueryBuilder("u")
      .addSelect("u.password")
      .where("u.email = :email", { email })
      .getOne();
  }

  async findByUsername(username: string, manager?: EntityManager): Promise<User | null> {
    return this.getRepo(manager).findOne({ where: { username } });
  }

  async findByUsernameWithPassword(
    username: string,
    manager?: EntityManager,
  ): Promise<User | null> {
    return this.getRepo(manager)
      .createQueryBuilder("u")
      .addSelect("u.password")
      .where("u.username = :username", { username })
      .getOne();
  }

  async findById(id: string, manager?: EntityManager): Promise<User | null> {
    return this.getRepo(manager).findOne({ where: { id } });
  }

  async create(data: Partial<User>, manager?: EntityManager): Promise<User> {
    const repo = this.getRepo(manager);
    return repo.save(repo.create(data));
  }

  async markEmailVerified(userId: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).update({ id: userId }, { emailVerifiedAt: new Date() });
  }

  async updatePasswordChanged(
    userId: string,
    passwordHash: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(
      { id: userId },
      { password: passwordHash, passwordChangedAt: new Date() },
    );
  }

  async findByIdWithPassword(id: string, manager?: EntityManager): Promise<User | null> {
    return this.getRepo(manager)
      .createQueryBuilder("u")
      .addSelect("u.password")
      .where("u.id = :id", { id })
      .getOne();
  }

  async updateLastLoginAt(userId: string, at: Date, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).update({ id: userId }, { lastLoginAt: at });
  }
}
