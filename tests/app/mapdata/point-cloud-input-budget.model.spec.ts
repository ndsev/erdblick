import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {PointCloudInputBudget} from "../../../app/mapdata/point-cloud-input-budget.model";

describe("retained point-cloud inputs", () => {
    it("checks aggregate replacements and releases evicted owners when the allowance shrinks", () => {
        const budget = new PointCloudInputBudget();
        const a = {}, b = {};
        const evictA = vi.fn(), evictB = vi.fn();
        budget.setWorkingLimit(16 * 1048576 + 400);
        expect(budget.admit(a, 60, evictA)).toBe(true);
        expect(budget.admit(b, 40, evictB)).toBe(true);
        expect(budget.admit(a, 61, evictA)).toBe(false);
        expect(budget.retainedBytes).toBe(100);
        budget.setWorkingLimit(16 * 1048576 + 160);
        expect(evictA).toHaveBeenCalledOnce();
        expect(evictB).not.toHaveBeenCalled();
        expect(budget.retainedBytes).toBe(40);
        budget.release(b);
        budget.release(b);
        expect(budget.retainedBytes).toBe(0);
    });
});
