import express from 'express';
import {
  registerAnonymousUser,
  registerUser,
  loginUser,
  getUserProfile,
  updateUserProfile,
  updateUserProfileImage,
  removeUserProfileImage,
  checkUsernameAvailability,
  updatePreferredGenres,
} from '../controllers/userController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/username-availability', checkUsernameAvailability);
router.post('/anonymous', registerAnonymousUser);
router.post('/signup', registerUser);
router.post('/login', loginUser);
router.get('/profile', requireAuth, getUserProfile);
router.put('/profile', requireAuth, updateUserProfile);
router.put('/preferences/genres', requireAuth, updatePreferredGenres);
router.put('/profile/image', requireAuth, updateUserProfileImage);
router.delete('/profile/image', requireAuth, removeUserProfileImage);

export default router;
