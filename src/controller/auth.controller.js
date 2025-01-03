import AppError from '../utils/AppError.js';
import { extractUser, generatePassword, generateTokenSet, checkPassword } from '../utils/user.js';

import { BAD_REQUEST, INTERNAL_SERVER, UN_AUTHORIZED } from '../constants/index.js';
import env from '../config/env.js';
import { handleRefreshTokenError, refreshTokenReuseDetection } from '../utils/auth.js';
import {
  assignRefreshToken,
  removeRefreshTokenUser,
  replaceRefreshTokenUser,
  saveUser,
  getUserByEmail,
  removeEmailVerifyToken,
  removeVerifyToken,
} from '../services/auth.services.js';
import { loginSchema, registerSchema, verifyEmailSchema } from '../validations/auth.validation.js';
import { checkTimeDifference, formatError, generateId, renderEmailEjs } from '../utils/helper.js';
import { emailQueue, emailQueueName } from '../jobs/email.queue.js';

export const createUser = async (req, res, next) => {
  try {
    const { firstName, lastName, email, role, password } = registerSchema.parse(req.body);

    const isUser = await getUserByEmail(email);
    if (isUser) {
      return next(new AppError('User already exists', BAD_REQUEST));
    }
    const hashedPassword = await generatePassword(password);
    const id = generateId();
    const verify_token = await generatePassword(id);
    const url = `${env.base_url}/verify/email/?email=${email}&token=${verify_token}`;

    const user = {
      firstName,
      lastName,
      email,
      role,
      password: hashedPassword,
      email_verify_token: verify_token,
      token_send_at: new Date().toISOString(),
    };

    saveUser(user)
      .then(async (savedUser) => {
        const html = await renderEmailEjs('emails/verify-mail', {
          name: `${firstName} ${lastName}`,
          url: url,
        });
        await emailQueue.add(emailQueueName, {
          to: email,
          subject: 'Verify your email address - Route Reserve',
          html: html,
        });
        return res.status(201).send({
          message: 'Account Created Successfully!',
          data: savedUser,
        });
      })
      .catch((error) => {
        return next(new AppError('Something went wrong', INTERNAL_SERVER));
      });
  } catch (error) {
    if (error instanceof Error) {
      const error = formatError(error);
      return next(new AppError(error, BAD_REQUEST));
    }
    return next(new AppError('Something went wrong', INTERNAL_SERVER));
  }
};

export const loginUser = async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    console.log('email', email);
    console.log('password', password);
    const user = await getUserByEmail(email, '_id email role password');

    if (!user) {
      return next(new AppError('User does not exist', BAD_REQUEST));
    }

    if (!(await checkPassword(password, user.password))) {
      return next(new AppError('Email or Password is incorrect', BAD_REQUEST));
    }

    const { accessToken, refreshToken } = generateTokenSet({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    await assignRefreshToken(user._id, refreshToken);

    res.cookie('refreshToken', refreshToken, {
      maxAge: env.jwt.refreshExpirationDays * 24 * 60 * 60 * 1000,
      secure: env.env === 'PRODUCTION' ? true : false,
      httpOnly: true,
      samesite: 'none',
    });

    return res.status(200).send({
      accessToken,
      message: 'Logged In Successfully!',
    });
  } catch (error) {
    console.log('error', error);
    return next(new AppError('Something went wrong', INTERNAL_SERVER));
  }
};

export const refreshTokenSets = async (req, res, next) => {
  try {
    const { refreshToken } = req.cookies;

    if (!refreshToken) {
      res.clearCookie('refreshToken');
      return next(new AppError('No refresh token found', UN_AUTHORIZED));
    }

    const decodedUser = extractUser(refreshToken, env.jwt.refresh_secret);
    req.user = decodedUser;

    const isHacker = await refreshTokenReuseDetection(decodedUser, refreshToken, res);
    if (isHacker) {
      return next(new AppError('Potential breach detected', UN_AUTHORIZED));
    }

    const tokenSet = generateTokenSet({
      id: decodedUser.id,
      email: decodedUser.email,
      role: decodedUser.role,
    });

    const updatedRefreshToken = await replaceRefreshTokenUser(
      decodedUser.id,
      refreshToken,
      tokenSet.refreshToken
    );
    if (updatedRefreshToken) {
      res.cookie('refreshToken', tokenSet.refreshToken, {
        maxAge: env.jwt.refreshExpirationDays * 24 * 60 * 60 * 1000,
        secure: env.env === 'PRODUCTION' ? true : false,
        httpOnly: true,
        samesite: 'none',
      });

      return res.status(201).send({
        accessToken: tokenSet.accessToken,
      });
    }
  } catch (error) {
    return handleRefreshTokenError(error, req, res);
  }
};

export const logOut = async (req, res, next) => {
  try {
    res.clearCookie('refreshToken');
    const { refreshToken } = req.cookies;

    if (!refreshToken) {
      return next(new AppError('No Refresh Token Found', UN_AUTHORIZED));
    }

    const decodedUser = extractUser(refreshToken, env.jwt.refresh_secret);

    const isHacker = await refreshTokenReuseDetection(decodedUser, refreshToken, res);
    if (isHacker) {
      return next(new AppError('Potential breach detected', UN_AUTHORIZED));
    }

    await removeRefreshTokenUser(decodedUser.id, refreshToken);
    return res.sendStatus(204);
  } catch (error) {
    return handleRefreshTokenError(error, req, res);
  }
};

export const verifyEmail = async (req, res, next) => {
  try {
    const { email, token } = verifyEmailSchema.parse(req.query);
    const user = await getUserByEmail(email, '_id email email_verify_token token_send_at');
    const token_gap = checkTimeDifference(user.token_send_at);

    if (token_gap > 86400000) {
      await removeVerifyToken(user._id);
      return next(new AppError('Token expired', BAD_REQUEST));
    }

    if (user) {
      if (token !== user.email_verify_token) {
        return next(new AppError('Invalid Token', BAD_REQUEST));
      }

      await removeEmailVerifyToken(user._id, token);

      return res.sendStatus(200);
    }
  } catch (error) {
    console.log('error', error);
    return next(new AppError('Something went wrong', INTERNAL_SERVER));
  }
};
