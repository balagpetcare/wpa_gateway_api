import 'dotenv/config';
import bcrypt from 'bcrypt';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AdminRole, AdminUserStatus, PrismaClient } from '@prisma/client';

import { env } from '../src/config/env.js';

const prisma = new PrismaClient();

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isStrongPassword(password: string) {
  return (
    password.length >= 12 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

async function promptIfMissing(question: string, currentValue?: string) {
  if (currentValue) {
    return currentValue;
  }

  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const name = await promptIfMissing('Super admin name: ', env.GATEWAY_ADMIN_BOOTSTRAP_NAME);
  const email = normalizeEmail(await promptIfMissing('Super admin email: ', env.GATEWAY_ADMIN_BOOTSTRAP_EMAIL));
  const password = await promptIfMissing('Super admin password: ', env.GATEWAY_ADMIN_BOOTSTRAP_PASSWORD);

  if (!name) {
    throw new Error('Name is required.');
  }

  if (!email.includes('@')) {
    throw new Error('A valid email address is required.');
  }

  if (!isStrongPassword(password)) {
    throw new Error('Password must be at least 12 characters and include upper, lower, number, and symbol.');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const existingAdmin = await prisma.adminUser.findUnique({
    where: { email },
  });

  if (!existingAdmin) {
    const admin = await prisma.adminUser.create({
      data: {
        name,
        email,
        passwordHash,
        role: AdminRole.SUPER_ADMIN,
        status: AdminUserStatus.ACTIVE,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    console.log(JSON.stringify({ created: true, updated: false, unchanged: false, adminId: admin.id, email: admin.email }, null, 2));
    return;
  }

  const passwordMatches = await bcrypt.compare(password, existingAdmin.passwordHash);
  const needsMetadataUpdate =
    existingAdmin.name !== name ||
    existingAdmin.role !== AdminRole.SUPER_ADMIN ||
    existingAdmin.status !== AdminUserStatus.ACTIVE ||
    existingAdmin.mustChangePassword !== false ||
    existingAdmin.failedLoginCount !== 0 ||
    existingAdmin.lockedUntil !== null;

  if (!passwordMatches || needsMetadataUpdate) {
    const admin = await prisma.$transaction(async (tx) => {
      const updated = await tx.adminUser.update({
        where: { id: existingAdmin.id },
        data: {
          name,
          passwordHash: passwordMatches ? undefined : passwordHash,
          role: AdminRole.SUPER_ADMIN,
          status: AdminUserStatus.ACTIVE,
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
          ...(passwordMatches
            ? {}
            : {
                tokenVersion: {
                  increment: 1,
                },
              }),
        },
      });

      if (!passwordMatches) {
        await tx.adminSession.updateMany({
          where: {
            adminId: existingAdmin.id,
            revokedAt: null,
          },
          data: {
            revokedAt: new Date(),
          },
        });
      }

      return updated;
    });

    console.log(
      JSON.stringify(
        {
          created: false,
          updated: true,
          unchanged: false,
          passwordUpdated: !passwordMatches,
          adminId: admin.id,
          email: admin.email,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    JSON.stringify({
      created: false,
      updated: false,
      unchanged: true,
      adminId: existingAdmin.id,
      email: existingAdmin.email,
    }, null, 2),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
