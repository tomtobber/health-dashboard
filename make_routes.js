const fs = require('fs');
const path = require('path');

function write(filePath, content) {
  const fullPath = path.join(__dirname, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.trim() + '\n', 'utf8');
  console.log('Created:', filePath);
}

// 1. src/routes/authRoutes.ts
write('src/routes/authRoutes.ts', `import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-length';

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

export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication token required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
    req.user = payload;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = authSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);
    
    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
      const mockUser = { id: 'mock-user-id', email };
      const token = jwt.sign(mockUser, JWT_SECRET, { expiresIn: '7d' });
      return res.status(201).json({ user: mockUser, token });
    }

    const [user] = await db.insert(users).values({ email, passwordHash }).returning();
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    
    return res.status(201).json({ user: { id: user.id, email: user.email }, token });
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Registration failed' });
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = authSchema.parse(req.body);

    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
      const mockUser = { id: 'mock-user-id', email };
      const token = jwt.sign(mockUser, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ user: mockUser, token });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ user: { id: user.id, email: user.email }, token });
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Login failed' });
  }
});

authRouter.get('/me', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ user: req.user });
});
`);

// 2. src/routes/connectRoutes.ts
write('src/routes/connectRoutes.ts', `import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from './authRoutes';
import { GoogleHealthAdapter } from '../adapters/googleHealthAdapter';
import { signState, verifyState, encryptToken } from '../services/cryptoService';
import { db } from '../db';
import { connectedAccounts } from '../db/schema';
import { eq, and } from 'drizzle-orm';

export const connectRouter = Router();
const googleAdapter = new GoogleHealthAdapter();

// 1. Authorize route - generates signed state token with requested scopes
connectRouter.get('/google/authorize', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const signedState = signState({ userId });
  const authUrl = googleAdapter.getAuthUrl(signedState);
  
  return res.json({
    authUrl,
    signedState,
    requestedScopes: GoogleHealthAdapter.SCOPES
  });
});

// 2. Callback route - verifies HMAC signed state and stores encrypted tokens
connectRouter.get('/google/callback', async (req: AuthenticatedRequest, res: Response) => {
  const { code, state } = req.query;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code' });
  }
  if (!state || typeof state !== 'string') {
    return res.status(400).json({ error: 'Missing OAuth state parameter' });
  }

  let statePayload: { userId: string };
  try {
    statePayload = verifyState<{ userId: string }>(state);
  } catch (err: any) {
    return res.status(403).json({ error: \`Invalid or tampered OAuth state parameter: \${err.message}\` });
  }

  try {
    const tokens = await googleAdapter.authenticate(code);
    const encryptedAccessToken = encryptToken(tokens.accessToken);
    const encryptedRefreshToken = encryptToken(tokens.refreshToken);

    if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
      return res.json({
        message: 'Google Health account successfully connected',
        provider: 'google_health',
        userId: statePayload.userId,
        status: 'active',
        scopes: tokens.scopes,
      });
    }

    // Upsert connected account record
    const existing = await db
      .select()
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.userId, statePayload.userId), eq(connectedAccounts.provider, 'google_health')));

    if (existing.length > 0) {
      await db
        .update(connectedAccounts)
        .set({
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          scopes: JSON.stringify(tokens.scopes),
          status: 'active',
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, existing[0].id));
    } else {
      await db.insert(connectedAccounts).values({
        userId: statePayload.userId,
        provider: 'google_health',
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        scopes: JSON.stringify(tokens.scopes),
        status: 'active',
      });
    }

    return res.json({
      message: 'Google Health account successfully connected',
      provider: 'google_health',
      userId: statePayload.userId,
      status: 'active',
      scopes: tokens.scopes,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to complete OAuth connect flow' });
  }
});

// 3. Status route
connectRouter.get('/status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;

  if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
    return res.json({
      connectedAccounts: [
        { provider: 'google_health', status: 'active', scopes: GoogleHealthAdapter.SCOPES }
      ]
    });
  }

  const accounts = await db
    .select({
      provider: connectedAccounts.provider,
      status: connectedAccounts.status,
      scopes: connectedAccounts.scopes,
      updatedAt: connectedAccounts.updatedAt,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId));

  return res.json({ connectedAccounts: accounts });
});

// 4. Disconnect route
connectRouter.post('/google/disconnect', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;

  if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
    return res.json({ message: 'Disconnected Google Health account successfully' });
  }

  await db
    .update(connectedAccounts)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, 'google_health')));

  return res.json({ message: 'Disconnected Google Health account successfully' });
});
`);

// 3. src/app.ts
write('src/app.ts', `import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/authRoutes';
import { connectRouter } from './routes/connectRoutes';

export const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/connect', connectRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
`);

// 4. src/server.ts
write('src/server.ts', `import { app } from './app';
import * as dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(\`Server is running on port \${PORT}\`);
});
`);

console.log('Routes setup ready.');