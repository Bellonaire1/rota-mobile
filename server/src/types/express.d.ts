declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
      };
      rawBody?: Buffer;
      teamMembership?: {
        teamId: string;
        userId: string;
        role: import('@prisma/client').TeamRole;
      };
    }
  }
}

export {};
