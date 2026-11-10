import { fmtBytes, fmtCpu } from './format';

describe('fmtBytes', () => {
  it('uses MB, then GB with one decimal under 10 GB', () => {
    const mb = 1024 * 1024;
    expect(fmtBytes(0)).toBe('<1 MB');
    expect(fmtBytes(104 * mb + 300)).toBe('104 MB');
    expect(fmtBytes(1536 * mb)).toBe('1.5 GB');
    expect(fmtBytes(12 * 1024 * mb)).toBe('12 GB');
  });
});

describe('fmtCpu', () => {
  it('shows small loads with a decimal and big ones rounded', () => {
    expect(fmtCpu(0.01)).toBe('0%');
    expect(fmtCpu(0.4)).toBe('0.4%');
    expect(fmtCpu(3)).toBe('3%');
    expect(fmtCpu(182.6)).toBe('183%');
  });
});
