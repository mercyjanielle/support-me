import prisma from "../prisma";
import { MoneyValue, toAmount } from "../lib/money";

/** Dashboard metrics for one currency (#224). */
export interface CurrencyStats {
  currency: string;
  total: number;
  donationCount: number;
  uniqueSupporters: number;
  average: number;
  largest: number;
}

/**
 * Dashboard metrics for a creator, PRD v2 section 6.6.
 *
 * Amounts in different assets can't be added together without a price, so
 * earnings, average and largest tip are reported per currency. Donation count
 * and unique supporters are currency-agnostic and reported overall too.
 */
export interface CreatorStats {
  donationCount: number;
  uniqueSupporters: number;
  currencies: CurrencyStats[];
}

interface StatsAggregate {
  // Donation.currency is NOT NULL; null identifies the overall grouping set.
  currency: string | null;
  donationCount: bigint;
  uniqueSupporters: bigint;
  total: MoneyValue | null;
  average: MoneyValue | null;
  largest: MoneyValue | null;
}

/** Converts database aggregates to the existing JSON response shape. */
export function buildCreatorStats(rows: StatsAggregate[]): CreatorStats {
  const overall = rows.find((row) => row.currency === null);
  const currencies = rows
    .filter((row): row is StatsAggregate & { currency: string } => row.currency !== null)
    .map((row) => ({
      currency: row.currency,
      total: toAmount(row.total),
      donationCount: Number(row.donationCount),
      uniqueSupporters: Number(row.uniqueSupporters),
      average: toAmount(row.average),
      largest: toAmount(row.largest),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    donationCount: Number(overall?.donationCount ?? 0),
    uniqueSupporters: Number(overall?.uniqueSupporters ?? 0),
    currencies,
  };
}

/** Loads dashboard metrics for a creator from verified donations only. */
export async function getCreatorStats(creatorId: number): Promise<CreatorStats> {
  // Count distinct senders in Postgres, including across currencies. Returning
  // one row per currency plus the overall row keeps application memory O(currencies),
  // independent of supporter count. Both views use the same statement snapshot.
  // The existing (creatorId, verified, createdAt) index supports these filters.
  const rows = await prisma.$queryRaw<StatsAggregate[]>`
    SELECT "currency", COUNT(*) AS "donationCount",
           COUNT(DISTINCT "senderAddress") AS "uniqueSupporters",
           SUM("amount") AS "total", AVG("amount") AS "average",
           MAX("amount") AS "largest"
    FROM "Donation"
    WHERE "creatorId" = ${creatorId} AND "verified" = true
    GROUP BY GROUPING SETS (("currency"), ())
  `;
  return buildCreatorStats(rows);
}
