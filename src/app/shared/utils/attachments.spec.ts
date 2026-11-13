import { attachmentName, splitAttachments, toBase64, withAttachments, withoutAttachments } from './attachments';

describe('attachments', () => {
  it('appends one line per file and splits them back off the end only', () => {
    const message = withAttachments('Sửa lỗi\n📎 giữa câu', ['C:\\Users\\a\\attachments\\1\\chụp.png', '/x/y/app.log']);
    expect(message).toBe('Sửa lỗi\n📎 giữa câu\n\n📎 C:\\Users\\a\\attachments\\1\\chụp.png\n📎 /x/y/app.log');
    const { text, files } = splitAttachments(message);
    expect(text).toBe('Sửa lỗi\n📎 giữa câu');
    expect(files).toEqual([
      { path: 'C:\\Users\\a\\attachments\\1\\chụp.png', name: 'chụp.png', image: true },
      { path: '/x/y/app.log', name: 'app.log', image: false },
    ]);
    expect(withAttachments('chữ', [])).toBe('chữ');
    expect(withAttachments('', ['/a.png'])).toBe('📎 /a.png');
  });

  it('titles a message by its words, or by its files when it has none', () => {
    expect(withoutAttachments('Sửa\n\n📎 /a/b.png')).toBe('Sửa');
    expect(withoutAttachments('📎 /a/b.png\n📎 /a/c.txt')).toBe('b.png, c.txt');
  });

  it('names a pasted screenshot by the time it was pasted', () => {
    const at = new Date(2026, 10, 13, 9, 5, 7);
    expect(attachmentName(new File([], 'image.png', { type: 'image/png' }), at)).toBe('anh-20261113-090507.png');
    expect(attachmentName(new File([], '', { type: 'image/jpeg' }), at)).toBe('anh-20261113-090507.jpg');
    expect(attachmentName(new File([], 'lỗi.log'), at)).toBe('lỗi.log');
  });

  it('encodes bytes as base64', () => {
    expect(toBase64(new TextEncoder().encode('TG Studio').buffer)).toBe(btoa('TG Studio'));
  });
});
