import mongoose from 'mongoose';

const bookSchema = new mongoose.Schema({
  title: { type: String, required: true },
  author: { type: String, required: true },
  source: {
    type: String,
    default: '',
    trim: true,
    lowercase: true,
  },
  sourceId: {
    type: String,
    default: '',
    trim: true,
  },
  coverImage: {
    type: String,
    default: '',
    trim: true,
  },
  gutenbergId: {
    type: Number,
    required: true,
    unique: true,
    index: true,
  },
  lastAccessedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

bookSchema.index({ title: 1 });
bookSchema.index({ lastAccessedAt: -1 });
bookSchema.index(
  { source: 1, sourceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: { $exists: true, $type: 'string', $ne: '' },
      sourceId: { $exists: true, $type: 'string', $ne: '' },
    },
  },
);

export const Book = mongoose.model('Book', bookSchema);
