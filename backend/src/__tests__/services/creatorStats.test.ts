jest.mock("../../prisma", () => ({
  __esModule: true,
  default: { $queryRaw: jest.fn(), donation: { groupBy: jest.fn(), findMany: jest.fn() } },
}));

import { Prisma } from "@prisma/client";
import prisma from "../../prisma";
import { buildCreatorStats, getCreatorStats } from "../../services/creatorStats";

const d = (v: string) => new Prisma.Decimal(v);
const overall = { currency: null, donationCount: 5n, uniqueSupporters: 2n,
  total: null, average: null, largest: null };

describe("buildCreatorStats", () => {
  it("returns zeroed stats for the empty overall group", () => {
    expect(buildCreatorStats([{ ...overall, donationCount: 0n, uniqueSupporters: 0n }])).toEqual({
      donationCount: 0, uniqueSupporters: 0, currencies: [],
    });
  });

  it("preserves numeric amounts, ordering, and cross-currency distinct counts", () => {
    const stats = buildCreatorStats([
      { currency: "XLM", donationCount: 3n, uniqueSupporters: 2n,
        total: d("35.5"), average: d("11.8333333"), largest: d("20") },
      overall,
      { currency: "USDC", donationCount: 2n, uniqueSupporters: 1n,
        total: d("7.0000001"), average: d("3.50000005"), largest: d("5") },
    ]);
    expect(stats).toEqual({
      donationCount: 5, uniqueSupporters: 2,
      currencies: [
        { currency: "USDC", total: 7.0000001, donationCount: 2, uniqueSupporters: 1,
          average: 3.50000005, largest: 5 },
        { currency: "XLM", total: 35.5, donationCount: 3, uniqueSupporters: 2,
          average: 11.8333333, largest: 20 },
      ],
    });
    expect(() => JSON.stringify(stats)).not.toThrow();
  });

  it("handles custom currencies and null amounts", () => {
    expect(buildCreatorStats([
      { currency: "MYTOKEN", donationCount: 0n, uniqueSupporters: 0n,
        total: null, average: null, largest: null },
    ]).currencies[0]).toEqual({
      currency: "MYTOKEN", total: 0, donationCount: 0, uniqueSupporters: 0, average: 0, largest: 0,
    });
  });
});

describe("getCreatorStats", () => {
  it("uses one parameterized aggregate query, never loading supporter rows", async () => {
    jest.mocked(prisma.$queryRaw).mockResolvedValue([overall]);
    expect(await getCreatorStats(123)).toEqual({ donationCount: 5, uniqueSupporters: 2, currencies: [] });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [parts, creatorId] = jest.mocked(prisma.$queryRaw).mock.calls[0];
    const sql = (parts as TemplateStringsArray).join("?");
    expect(creatorId).toBe(123);
    expect(sql).toContain('"creatorId" = ? AND "verified" = true');
    expect(sql).toContain('COUNT(DISTINCT "senderAddress")');
    expect(prisma.donation.groupBy).not.toHaveBeenCalled();
    expect(prisma.donation.findMany).not.toHaveBeenCalled();
  });
});
