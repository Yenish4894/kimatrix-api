import type { NextFunction, Request, Response } from "express";

export interface PaginationQuery {
  page?: number | string;
  limit?: number | string;
}

export abstract class BaseController {
  protected sendSuccess<T>(res: Response, data: T, message = "Success", statusCode = 200): void {
    res.status(statusCode).json({
      success: true,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  protected async handle(
    req: Request,
    res: Response,
    next: NextFunction,
    operation: () => Promise<{ data: unknown; message?: string; statusCode?: number }>,
  ): Promise<void> {
    try {
      const { data, message, statusCode } = await operation();
      this.sendSuccess(res, data, message, statusCode);
    } catch (err) {
      next(err);
    }
  }

  protected getPagination(query: PaginationQuery): { page: number; limit: number } {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    return { page, limit };
  }

  protected paginationResponse<T>(items: T[], total: number, page: number, limit: number) {
    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
}
