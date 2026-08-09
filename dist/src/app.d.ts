import express, { Request, Response, NextFunction } from 'express';
export declare const app: import("express-serve-static-core").Express;
export declare function errorHandlerMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): express.Response<any, Record<string, any>>;
