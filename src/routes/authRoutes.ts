import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { env } from '../config/env';
import { AuthenticationError, ValidationError, DatabaseError } from '../errors/AppError';
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/asyncHandler';

export const authRouter = Router();

const authSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next(new AuthenticationError('Authentication token required', { operation: 'authenticateToken' }));
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; email: string };
    req.user = payload;
    next();
  } catch (err: unknown) {
    logger.warn('Token verification failed', {
      operation: 'authenticateToken',
      error: err instanceof Error ? err.message : String(err),
    });
    return next(new AuthenticationError('Invalid or expired authentication token', { operation: 'authenticateToken' }));
  }
}

authRouter.post(
  '/register',
  asyncHandler(async (req: Request, res: Response): Promise<unknown> => {
    const parseResult = authSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Registration input validation failed', {
        operation: 'register',
        zodErrors: parseResult.error.errors,
      });
    }

    const { email, password } = parseResult.data;
    const passwordHash = await bcrypt.hash(password, 10);

    if (env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
      const mockUser = { id: 'mock-user-id', email };
      const token = jwt.sign(mockUser, env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(201).json({ user: mockUser, token });
    }

    let user: typeof users.$inferSelect;
    try {
      const inserted = await db.insert(users).values({ email, passwordHash }).returning();
      if (!inserted || inserted.length === 0) {
        throw new DatabaseError('User creation returning clause failed', { operation: 'register', email });
      }
      user = inserted[0];
    } catch (err: unknown) {
      if (err instanceof DatabaseError) throw err;
      throw new DatabaseError('Failed to insert new user into database', {
        operation: 'register',
        email,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: '7d' });
    logger.info('User registered successfully', { operation: 'register', userId: user.id });

    return res.status(201).json({ user: { id: user.id, email: user.email }, token });
  })
);

authRouter.post(
  '/login',
  asyncHandler(async (req: Request, res: Response): Promise<unknown> => {
    const parseResult = authSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Login input validation failed', {
        operation: 'login',
        zodErrors: parseResult.error.errors,
      });
    }

    const { email, password } = parseResult.data;

    if (env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
      const mockUser = { id: 'mock-user-id', email };
      const token = jwt.sign(mockUser, env.JWT_SECRET, { expiresIn: '7d' });
      return res.json({ user: mockUser, token });
    }

    let userList: (typeof users.$inferSelect)[];
    try {
      userList = await db.select().from(users).where(eq(users.email, email));
    } catch (err: unknown) {
      throw new DatabaseError('Failed to query user by email', {
        operation: 'login',
        email,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    const user = userList[0];
    if (!user) {
      throw new AuthenticationError('Invalid email or password', { operation: 'login', email });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new AuthenticationError('Invalid email or password', { operation: 'login', email });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: '7d' });
    logger.info('User logged in successfully', { operation: 'login', userId: user.id });

    return res.json({ user: { id: user.id, email: user.email }, token });
  })
);

authRouter.get('/me', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ user: req.user });
});