import { Request, Response, NextFunction } from "express";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public error: string = "Error"
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(
  err: Error & { type?: string; status?: number },
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.error,
      message: err.message,
      statusCode: err.statusCode,
    });
    return;
  }
  // JSON mal formado o body demasiado grande (body-parser).
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
    const status = err.type === "entity.too.large" ? 413 : 400;
    res.status(status).json({ error: "Bad Request", message: "Cuerpo de la solicitud inválido", statusCode: status });
    return;
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error", message: "An unexpected error occurred", statusCode: 500 });
}
