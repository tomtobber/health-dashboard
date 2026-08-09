"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
exports.authenticateToken = authenticateToken;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const zod_1 = require("zod");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const env_1 = require("../config/env");
const AppError_1 = require("../errors/AppError");
const logger_1 = require("../utils/logger");
exports.authRouter = (0, express_1.Router)();
const authSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
});
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return next(new AppError_1.AuthenticationError('Authentication token required', { operation: 'authenticateToken' }));
    }
    try {
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
        req.user = payload;
        next();
    }
    catch (err) {
        logger_1.logger.warn('Token verification failed', {
            operation: 'authenticateToken',
            error: err instanceof Error ? err.message : String(err),
        });
        return next(new AppError_1.AuthenticationError('Invalid or expired authentication token', { operation: 'authenticateToken' }));
    }
}
exports.authRouter.post('/register', async (req, res, next) => {
    try {
        const parseResult = authSchema.safeParse(req.body);
        if (!parseResult.success) {
            throw new AppError_1.ValidationError('Registration input validation failed', {
                operation: 'register',
                zodErrors: parseResult.error.errors,
            });
        }
        const { email, password } = parseResult.data;
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        if (env_1.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
            const mockUser = { id: 'mock-user-id', email };
            const token = jsonwebtoken_1.default.sign(mockUser, env_1.env.JWT_SECRET, { expiresIn: '7d' });
            return res.status(201).json({ user: mockUser, token });
        }
        let user;
        try {
            const inserted = await db_1.db.insert(schema_1.users).values({ email, passwordHash }).returning();
            if (!inserted || inserted.length === 0) {
                throw new AppError_1.DatabaseError('User creation returning clause failed', { operation: 'register', email });
            }
            user = inserted[0];
        }
        catch (err) {
            if (err instanceof AppError_1.DatabaseError)
                throw err;
            throw new AppError_1.DatabaseError('Failed to insert new user into database', {
                operation: 'register',
                email,
                cause: err instanceof Error ? err.message : String(err),
            });
        }
        const token = jsonwebtoken_1.default.sign({ id: user.id, email: user.email }, env_1.env.JWT_SECRET, { expiresIn: '7d' });
        logger_1.logger.info('User registered successfully', { operation: 'register', userId: user.id });
        return res.status(201).json({ user: { id: user.id, email: user.email }, token });
    }
    catch (error) {
        next(error);
    }
});
exports.authRouter.post('/login', async (req, res, next) => {
    try {
        const parseResult = authSchema.safeParse(req.body);
        if (!parseResult.success) {
            throw new AppError_1.ValidationError('Login input validation failed', {
                operation: 'login',
                zodErrors: parseResult.error.errors,
            });
        }
        const { email, password } = parseResult.data;
        if (env_1.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
            const mockUser = { id: 'mock-user-id', email };
            const token = jsonwebtoken_1.default.sign(mockUser, env_1.env.JWT_SECRET, { expiresIn: '7d' });
            return res.json({ user: mockUser, token });
        }
        let userList;
        try {
            userList = await db_1.db.select().from(schema_1.users).where((0, drizzle_orm_1.eq)(schema_1.users.email, email));
        }
        catch (err) {
            throw new AppError_1.DatabaseError('Failed to query user by email', {
                operation: 'login',
                email,
                cause: err instanceof Error ? err.message : String(err),
            });
        }
        const user = userList[0];
        if (!user) {
            throw new AppError_1.AuthenticationError('Invalid email or password', { operation: 'login', email });
        }
        const valid = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!valid) {
            throw new AppError_1.AuthenticationError('Invalid email or password', { operation: 'login', email });
        }
        const token = jsonwebtoken_1.default.sign({ id: user.id, email: user.email }, env_1.env.JWT_SECRET, { expiresIn: '7d' });
        logger_1.logger.info('User logged in successfully', { operation: 'login', userId: user.id });
        return res.json({ user: { id: user.id, email: user.email }, token });
    }
    catch (error) {
        next(error);
    }
});
exports.authRouter.get('/me', authenticateToken, (req, res) => {
    return res.json({ user: req.user });
});
