import { Prisma } from '@prisma/client';
import { prisma } from '../src/db.js';
import { sanitizeBranchRoles, BranchRole } from '../src/utils/branchRoles.js';

type CliOptions = {
  email?: string;
  garages?: string[];
  role?: BranchRole;
  userRole?: 'ADMIN' | 'USER' | 'RECEPTIONMATE_STAFF';
  set?: boolean;
};

const parseArgs = (): CliOptions => {
  const options: CliOptions = {};
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--email' && args[i + 1]) {
      options.email = args[i + 1];
      i += 1;
    } else if ((arg === '--garages' || arg === '--add') && args[i + 1]) {
      const value = args[i + 1];
      const ids = value.split(',').map((entry) => entry.trim()).filter(Boolean);
      options.garages = [...(options.garages ?? []), ...ids];
      i += 1;
    } else if (arg === '--role' && args[i + 1]) {
      const roleValue = args[i + 1];
      if (roleValue !== 'MANAGER' && roleValue !== 'USER') {
        throw new Error(`Invalid role "${roleValue}". Use MANAGER or USER.`);
      }
      options.role = roleValue;
      i += 1;
    } else if (arg === '--user-role' && args[i + 1]) {
      const value = args[i + 1];
      if (value !== 'ADMIN' && value !== 'USER' && value !== 'RECEPTIONMATE_STAFF') {
        throw new Error(`Invalid user role "${value}". Use ADMIN, USER, or RECEPTIONMATE_STAFF.`);
      }
      options.userRole = value;
      i += 1;
    } else if (arg === '--set') {
      options.set = true;
    } else {
      throw new Error(`Unrecognized argument "${arg}".`);
    }
  }

  return options;
};

const main = async () => {
  const { email, garages, role, userRole, set } = parseArgs();

  if (!email) {
    throw new Error('Provide --email you want to update.');
  }
  if ((!garages || garages.length === 0) && !userRole) {
    throw new Error('Provide --garages id1,id2 or --user-role to update.');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`User with email ${email} not found.`);
  }

  const currentIds = Array.isArray(user.garageAccessIds) ? user.garageAccessIds : [];
  const nextIds = set ? Array.from(new Set(garages)) : Array.from(new Set([...currentIds, ...(garages ?? [])]));

  const data: Prisma.UserUpdateInput = {};

  if (garages && garages.length > 0) {
    data.garageAccessIds = nextIds;
  }

  if (userRole) {
    data.role = userRole;
  }

  if (role && garages && garages.length > 0) {
    const currentBranchRoles = sanitizeBranchRoles(user.branchRoles);
    const updatedRoles = { ...currentBranchRoles };
    nextIds.forEach((garageId) => {
      if (garages.includes(garageId)) {
        updatedRoles[garageId] = role;
      }
    });
    data.branchRoles = updatedRoles;
  }

  if (Object.keys(data).length === 0) {
    throw new Error('Nothing to update. Provide garages, --role, or --user-role.');
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data });

  console.log(JSON.stringify({
    id: updated.id,
    email: updated.email,
    garageAccessIds: updated.garageAccessIds,
    role: updated.role,
    branchRoles: sanitizeBranchRoles(updated.branchRoles),
  }, null, 2));
};

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
