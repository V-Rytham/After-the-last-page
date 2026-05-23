import mongoose from 'mongoose';

const canonicalBookSchema = new mongoose.Schema(
  {
    canonical_book_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    title: { type: String, required: true, trim: true },
    author: { type: String, default: '', trim: true },
    normalized_key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
  },
  { timestamps: true },
);

canonicalBookSchema.index({ normalized_key: 1 }, { unique: true });
canonicalBookSchema.index({ canonical_book_id: 1 }, { unique: true });

export const CanonicalBook = mongoose.model('CanonicalBook', canonicalBookSchema, 'books_canonical');
