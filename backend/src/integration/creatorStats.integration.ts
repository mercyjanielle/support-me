import prisma from "../prisma";
import { getCreatorStats } from "../services/creatorStats";
import { toAmount } from "../lib/money";

let creatorId: number;
let sequence = 0;

beforeEach(async () => {
  const schema = process.env.INTEGRATION_SCHEMA;
  if (!schema || !/^integration_[a-f0-9]{32}$/.test(schema) ||
      new URL(process.env.DATABASE_URL!).searchParams.get("schema") !== schema) {
    throw new Error("Use npm run test:integration with its isolated database/schema");
  }
  const creator = await prisma.creator.create({
    data: { username: `stats-${++sequence}`, user: { create: {} } },
  });
  creatorId = creator.id;
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await prisma.$disconnect(); });

// Reference the previous implementation using real Prisma aggregates and sets.
async function previousStats(id: number) {
  const where = { creatorId: id, verified: true };
  const [amounts, supporters] = await Promise.all([
    prisma.donation.groupBy({ by: ["currency"], where, _count: { _all: true },
      _sum: { amount: true }, _avg: { amount: true }, _max: { amount: true } }),
    prisma.donation.groupBy({ by: ["currency", "senderAddress"], where }),
  ]);
  const currencies = amounts.map((row) => ({
    currency: row.currency, total: toAmount(row._sum.amount), donationCount: row._count._all,
    uniqueSupporters: new Set(supporters.filter((s) => s.currency === row.currency).map((s) => s.senderAddress)).size,
    average: toAmount(row._avg.amount), largest: toAmount(row._max.amount),
  })).sort((a, b) => a.currency.localeCompare(b.currency));
  return { donationCount: currencies.reduce((sum, c) => sum + c.donationCount, 0),
    uniqueSupporters: new Set(supporters.map((s) => s.senderAddress)).size, currencies };
}

it("preserves zero stats for empty and unverified-only creators", async () => {
  const zero = { donationCount: 0, uniqueSupporters: 0, currencies: [] };
  expect(await getCreatorStats(creatorId)).toEqual(zero);
  await prisma.donation.create({ data: { creatorId, senderAddress: "pending", amount: 100,
    verified: false, transactionHash: `pending-${creatorId}` } });
  expect(await getCreatorStats(creatorId)).toEqual(await previousStats(creatorId));
  expect(await getCreatorStats(creatorId)).toEqual(zero);
});

it("matches legacy results with 12000 donations while returning only currency aggregates", async () => {
  const other = await prisma.creator.create({ data: { username: "stats-other", user: { create: {} } } });
  await prisma.donation.createMany({ data: [
    { creatorId: other.id, senderAddress: "other-only", amount: 99999, currency: "OTHER", transactionHash: "other" },
    { creatorId, senderAddress: "pending-only", amount: 99999, currency: "PENDING", verified: false, transactionHash: "pending-large" },
  ] });
  const currencies = ["XLM", "USDC", "MYTOKEN"];
  for (let start = 0; start < 12000; start += 1000) {
    await prisma.donation.createMany({ data: Array.from({ length: 1000 }, (_, offset) => {
      const i = start + offset;
      return { creatorId, senderAddress: `supporter-${i % 4000}`, currency: currencies[i % 3],
        amount: `${i % 7}.0000001`, transactionHash: `stats-${i}` };
    }) });
  }
  // Repeated, case-sensitive, and empty addresses retain the old set semantics.
  await prisma.donation.createMany({ data: ["", "GA", "Ga", "GA"].map((senderAddress, i) => ({
    creatorId, senderAddress, currency: "XLM", amount: "0.0000001", transactionHash: `edge-${i}`,
  })) });
  const expected = await previousStats(creatorId);
  const query = jest.spyOn(prisma, "$queryRaw");
  const groups = jest.spyOn(prisma.donation, "groupBy");
  const rows = jest.spyOn(prisma.donation, "findMany");
  const actual = await getCreatorStats(creatorId);
  expect(actual).toEqual(expected);
  expect(actual.donationCount).toBe(12004);
  expect(actual.uniqueSupporters).toBe(4003);
  expect(actual.currencies.map((c) => c.currency)).toEqual(["MYTOKEN", "USDC", "XLM"]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(await query.mock.results[0].value).toHaveLength(4);
  expect(groups).not.toHaveBeenCalled();
  expect(rows).not.toHaveBeenCalled();
  expect(() => JSON.stringify(actual)).not.toThrow();
});
