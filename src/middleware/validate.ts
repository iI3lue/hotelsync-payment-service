import { Request, Response, NextFunction } from "express";
import { AnyZodObject, ZodError } from "zod";

type Source = "body" | "params" | "query";

/**
 * Validación Zod en el borde. Los errores nunca devuelven el valor recibido
 * (podría ser un número de tarjeta): solo ruta y mensaje.
 */
export const validate = (schema: AnyZodObject, source: Source = "body") =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = await schema.parseAsync(req[source]);
      if (source === "body") req.body = parsed;
      else Object.assign(req[source], parsed);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: "Validation failed",
          details: error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
        return;
      }
      next(error);
    }
  };
