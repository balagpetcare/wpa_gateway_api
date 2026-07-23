import assert from 'node:assert/strict';

import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';
import { AdminRole, AdminUserStatus } from '@prisma/client';

import { buildApp } from '../../app.js';
import { prisma } from '../../config/prisma.js';

const TEST_EMAIL_PREFIX = 'local-auth-test-';
const SUPER_ADMIN_PASSWORD = 'SuperAdmin!234';
const ADMIN_PASSWORD = 'RegularAdmin!234';
const UPDATED_ADMIN_PASSWORD = 'UpdatedAdmin!234';
const CREATED_ADMIN_PASSWORD = 'CreatedAdmin!234';

type LoginResult = {
  token: string;
  refresh_token: string;
  session_id: string;
  user: {
    id: string;
    email: string;
    role: AdminRole;
    mustChangePassword: boolean;
  };
};

let loginRequestCounter = 0;

function testEmail(label: string) {
  return `${TEST_EMAIL_PREFIX}${label}@example.com`;
}

async function cleanupTestAdmins() {
  const users = await prisma.adminUser.findMany({
    where: {
      email: {
        startsWith: TEST_EMAIL_PREFIX,
      },
    },
    select: {
      id: true,
    },
  });

  if (users.length === 0) {
    return;
  }

  const ids = users.map((user) => user.id);

  await prisma.adminAuditLog.deleteMany({
    where: {
      OR: [{ actorAdminId: { in: ids } }, { targetAdminId: { in: ids } }, { entityId: { in: ids } }],
    },
  });
  await prisma.passwordResetToken.deleteMany({ where: { adminId: { in: ids } } });
  await prisma.adminSession.deleteMany({ where: { adminId: { in: ids } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: ids } } });
}

async function createAdmin(params: {
  email: string;
  password: string;
  role: AdminRole;
  name?: string;
  status?: AdminUserStatus;
  mustChangePassword?: boolean;
  createdById?: string;
}) {
  return prisma.adminUser.create({
    data: {
      name: params.name ?? params.email,
      email: params.email,
      passwordHash: await bcrypt.hash(params.password, 12),
      role: params.role,
      status: params.status ?? AdminUserStatus.ACTIVE,
      mustChangePassword: params.mustChangePassword ?? false,
      createdById: params.createdById ?? null,
    },
  });
}

async function login(app: FastifyInstance, email: string, password: string, rememberMe = false) {
  loginRequestCounter += 1;

  const response = await app.inject({
    method: 'POST',
    url: '/admin/auth/login',
    remoteAddress: `127.0.0.${Math.min(250, loginRequestCounter + 1)}`,
    payload: {
      emailOrUsername: email,
      password,
      rememberMe,
    },
  });

  return {
    response,
    body: response.json() as LoginResult,
  };
}

async function createAuthenticatedApp() {
  const app = buildApp();
  await app.ready();
  return app;
}

export async function runLocalAdminAuthTests() {
  console.log('--- Starting Local Admin Auth Tests ---');
  loginRequestCounter = 0;

  await cleanupTestAdmins();
  const baselineActiveSuperAdmins = await prisma.adminUser.count({
    where: {
      role: AdminRole.SUPER_ADMIN,
      status: AdminUserStatus.ACTIVE,
      email: {
        not: {
          startsWith: TEST_EMAIL_PREFIX,
        },
      },
    },
  });
  const app = await createAuthenticatedApp();

  try {
    const superAdmin = await createAdmin({
      email: testEmail('super'),
      password: SUPER_ADMIN_PASSWORD,
      role: AdminRole.SUPER_ADMIN,
      name: 'Local Auth Super',
    });

    const admin = await createAdmin({
      email: testEmail('admin'),
      password: ADMIN_PASSWORD,
      role: AdminRole.ADMIN,
      name: 'Local Auth Admin',
      createdById: superAdmin.id,
    });

    const initialSuperLogin = await login(app, superAdmin.email, SUPER_ADMIN_PASSWORD, true);
    assert.equal(initialSuperLogin.response.statusCode, 200, 'super admin login should succeed');
    assert.equal(initialSuperLogin.body.user.email, superAdmin.email);
    assert.equal(initialSuperLogin.body.user.role, AdminRole.SUPER_ADMIN);

    const initialAdminLogin = await login(app, admin.email, ADMIN_PASSWORD);
    assert.equal(initialAdminLogin.response.statusCode, 200, 'admin login should succeed');

    {
      const { response } = await login(app, superAdmin.email, 'WrongPassword!234');
      assert.equal(response.statusCode, 401, 'invalid credentials should fail');
    }

    {
      const usernameLoginResponse = await app.inject({
        method: 'POST',
        url: '/admin/auth/login',
        payload: {
          emailOrUsername: superAdmin.email.split('@')[0],
          password: SUPER_ADMIN_PASSWORD,
        },
      });

      assert.equal(usernameLoginResponse.statusCode, 200, 'username-style login identifier should be accepted');
    }

    {
      const suspendedAdmin = await createAdmin({
        email: testEmail('suspended'),
        password: 'SuspendedAdmin!234',
        role: AdminRole.VIEWER,
        status: AdminUserStatus.SUSPENDED,
        name: 'Suspended Admin',
        createdById: superAdmin.id,
      });

      const suspendedLogin = await login(app, suspendedAdmin.email, 'SuspendedAdmin!234');
      assert.equal(suspendedLogin.response.statusCode, 403, 'suspended admins must not be able to log in');
    }

    {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/admin/admin-users',
        headers: {
          authorization: `Bearer ${initialSuperLogin.body.token}`,
        },
        payload: {
          name: 'Created Admin',
          email: testEmail('created'),
          password: CREATED_ADMIN_PASSWORD,
          role: AdminRole.VIEWER,
          status: AdminUserStatus.ACTIVE,
          mustChangePassword: true,
        },
      });

      assert.equal(createResponse.statusCode, 201, 'super admin should be able to create admins');

      const createdLogin = await login(app, testEmail('created'), CREATED_ADMIN_PASSWORD);
      assert.equal(createdLogin.response.statusCode, 200, 'newly created admin should be able to sign in');
      assert.equal(createdLogin.body.user.mustChangePassword, true, 'created admin should keep mustChangePassword');
    }

    {
      const forbiddenResponse = await app.inject({
        method: 'POST',
        url: '/admin/admin-users',
        headers: {
          authorization: `Bearer ${initialAdminLogin.body.token}`,
        },
        payload: {
          name: 'Escalated Admin',
          email: testEmail('escalation'),
          password: CREATED_ADMIN_PASSWORD,
          role: AdminRole.SUPER_ADMIN,
        },
      });

      assert.equal(forbiddenResponse.statusCode, 403, 'non-super admins must not manage admin users');
    }

    {
      const firstLogin = await login(app, admin.email, ADMIN_PASSWORD, true);
      const secondLogin = await login(app, admin.email, ADMIN_PASSWORD, true);

      assert.equal(firstLogin.response.statusCode, 200, 'first admin session should succeed');
      assert.equal(secondLogin.response.statusCode, 200, 'second admin session should succeed');

      const beforePasswordChange = await prisma.adminUser.findUniqueOrThrow({
        where: { id: admin.id },
        select: { tokenVersion: true, mustChangePassword: true },
      });

      const changeResponse = await app.inject({
        method: 'POST',
        url: '/admin/auth/change-password',
        headers: {
          authorization: `Bearer ${firstLogin.body.token}`,
        },
        payload: {
          currentPassword: ADMIN_PASSWORD,
          newPassword: UPDATED_ADMIN_PASSWORD,
        },
      });

      assert.equal(changeResponse.statusCode, 200, 'password change should succeed');
      const changedBody = changeResponse.json() as LoginResult;

      const afterPasswordChange = await prisma.adminUser.findUniqueOrThrow({
        where: { id: admin.id },
        select: { tokenVersion: true, mustChangePassword: true },
      });

      assert.equal(afterPasswordChange.mustChangePassword, false, 'password change should clear mustChangePassword');
      assert.equal(
        afterPasswordChange.tokenVersion,
        beforePasswordChange.tokenVersion + 1,
        'password change should increment tokenVersion',
      );

      const currentSessionMe = await app.inject({
        method: 'GET',
        url: '/admin/auth/me',
        headers: {
          authorization: `Bearer ${changedBody.token}`,
        },
      });
      assert.equal(currentSessionMe.statusCode, 200, 'current session should remain valid after password change');

      const oldAccessTokenMe = await app.inject({
        method: 'GET',
        url: '/admin/auth/me',
        headers: {
          authorization: `Bearer ${secondLogin.body.token}`,
        },
      });
      assert.equal(oldAccessTokenMe.statusCode, 401, 'other sessions must be invalidated after password change');

      const oldRefreshResponse = await app.inject({
        method: 'POST',
        url: '/admin/auth/refresh',
        payload: {
          refresh_token: secondLogin.body.refresh_token,
        },
      });
      assert.equal(oldRefreshResponse.statusCode, 401, 'revoked refresh tokens must not rotate after password change');

      const relogin = await login(app, admin.email, UPDATED_ADMIN_PASSWORD);
      assert.equal(relogin.response.statusCode, 200, 'updated password should authenticate');
    }

    {
      const resetTarget = await createAdmin({
        email: testEmail('reset-target'),
        password: 'ResetTarget!234',
        role: AdminRole.VIEWER,
        name: 'Reset Target',
        createdById: superAdmin.id,
      });

      const issueResetResponse = await app.inject({
        method: 'POST',
        url: '/admin/admin-users/password-reset-token',
        headers: {
          authorization: `Bearer ${initialSuperLogin.body.token}`,
        },
        payload: {
          adminUserId: resetTarget.id,
        },
      });

      assert.equal(issueResetResponse.statusCode, 201, 'super admin should issue reset tokens');
      const issuedToken = (issueResetResponse.json() as { data: { temporaryPasswordResetToken: string } }).data.temporaryPasswordResetToken;

      const firstReset = await app.inject({
        method: 'POST',
        url: '/admin/auth/reset-password',
        payload: {
          token: issuedToken,
          newPassword: 'ResetTargetNew!234',
        },
      });
      assert.equal(firstReset.statusCode, 200, 'valid reset token should succeed once');

      const secondReset = await app.inject({
        method: 'POST',
        url: '/admin/auth/reset-password',
        payload: {
          token: issuedToken,
          newPassword: 'AnotherReset!234',
        },
      });
      assert.equal(secondReset.statusCode, 401, 'reset tokens must be single use');

      const secondIssueResponse = await app.inject({
        method: 'POST',
        url: '/admin/admin-users/password-reset-token',
        headers: {
          authorization: `Bearer ${initialSuperLogin.body.token}`,
        },
        payload: {
          adminUserId: resetTarget.id,
        },
      });
      const expiringToken = (secondIssueResponse.json() as { data: { temporaryPasswordResetToken: string } }).data.temporaryPasswordResetToken;
      const tokenId = expiringToken.split('.')[0];
      assert.ok(tokenId, 'issued token should contain an id');

      await prisma.passwordResetToken.update({
        where: { id: tokenId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const expiredReset = await app.inject({
        method: 'POST',
        url: '/admin/auth/reset-password',
        payload: {
          token: expiringToken,
          newPassword: 'ExpiredReset!234',
        },
      });
      assert.equal(expiredReset.statusCode, 401, 'expired reset tokens must fail');
    }

    {
      if (baselineActiveSuperAdmins === 0) {
        const demoteSelfResponse = await app.inject({
          method: 'PATCH',
          url: `/admin/admin-users/${superAdmin.id}`,
          headers: {
            authorization: `Bearer ${initialSuperLogin.body.token}`,
          },
          payload: {
            role: AdminRole.ADMIN,
          },
        });
        assert.equal(demoteSelfResponse.statusCode, 403, 'final active super admin must not self-demote');

        const disableSelfResponse = await app.inject({
          method: 'PATCH',
          url: `/admin/admin-users/${superAdmin.id}/status`,
          headers: {
            authorization: `Bearer ${initialSuperLogin.body.token}`,
          },
          payload: {
            status: AdminUserStatus.DISABLED,
          },
        });
        assert.equal(disableSelfResponse.statusCode, 403, 'final active super admin must not be disabled');
      } else {
        console.log(
          `Skipped final active SUPER_ADMIN route assertion because ${baselineActiveSuperAdmins} pre-existing active SUPER_ADMIN account(s) exist in the shared database.`,
        );
      }
    }

    {
      const registerResponse = await app.inject({
        method: 'POST',
        url: '/admin/auth/register',
        payload: {
          email: 'public@example.com',
          password: 'PublicRegister!234',
        },
      });
      assert.equal(registerResponse.statusCode, 404, 'public registration must remain unavailable');
    }

    console.log('Local admin auth tests passed.');
  } finally {
    await app.close();
    await cleanupTestAdmins();
  }
}
