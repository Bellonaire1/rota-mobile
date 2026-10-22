declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
      };
      teamMembership?: {
        teamId: string;
        userId: string;
        role: import('@prisma/client').TeamRole;
      };
    }
  }
}

export {};
