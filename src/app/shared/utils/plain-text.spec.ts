import { plainText } from './plain-text';

describe('plainText', () => {
  it('bỏ định dạng và giữ chữ tiếng Việt', () => {
    expect(plainText('# **Tiêu đề**\n> __Trích dẫn__\n- *Một*\n+ _Hai_\n1. [Ba](https://example.com)')).toBe('Tiêu đề\nTrích dẫn\nMột\nHai\nBa');
  });
  it('giữ nội dung code và dấu trong tên biến', () => {
    expect(plainText('`my_var * 2` và my_var, **x**')).toBe('my_var * 2 và my_var, x');
    expect(plainText('')).toBe('');
  });
});
