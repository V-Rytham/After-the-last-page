import express from 'express';
import { asyncHandler } from '../utils/http.js';
import { getSearch, getBooksSearch } from '../controllers/searchController.js';

const router = express.Router();
router.get('/api/search', asyncHandler(getSearch));
router.get('/api/books/search', asyncHandler(getBooksSearch));
export default router;
