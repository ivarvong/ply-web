// Format facts the write API checks itself. Numeric literals that encode a git rule live here, next to the
// spec, and the rest of src/write imports the names. Mirrors ply's src/format.js for the facts ply does not re-export.

/** SHA-1 object id width. gitformat-pack(5): object names in packs are 20 bytes. */
export const OID_BYTES = 20;
/** Hex digits in a SHA-1 object name. Two hex characters per byte. */
export const OID_HEX_CHARS = OID_BYTES * 2;

/**
 * Tree modes git writes (gitobject(7); the tree stores the octal text with no leading zero).
 * `100644` regular file, `100755` executable, `120000` symlink, `40000` tree.
 */
export const MODE_BLOB = '100644';
export const MODE_EXEC = '100755';
export const MODE_LINK = '120000';
export const MODE_TREE = '40000';

export const BLOB_MODES = Object.freeze([MODE_BLOB, MODE_EXEC, MODE_LINK]);

/** Sentinel shared with String.prototype.indexOf and ply's indexOfBytes: the needle is absent. */
export const NOT_FOUND = -1;

/** Change operations one commit can apply, in order. */
export const OP_CREATE = 'create';
export const OP_WRITE = 'write';
export const OP_EDIT = 'edit';
export const OP_DELETE = 'delete';
export const OP_RENAME = 'rename';
