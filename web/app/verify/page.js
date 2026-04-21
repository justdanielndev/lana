'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { appwriteAccount, hasAppwriteConfig } from '../../lib/appwrite-client';

function isParamError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('missing required parameter') || message.includes('unknown parameter');
}

function formatAppwriteError(error) {
  const parts = [];
  if (typeof error?.code === 'number') parts.push(`code ${error.code}`);
  if (typeof error?.type === 'string' && error.type.trim()) parts.push(error.type.trim());
  if (typeof error?.message === 'string' && error.message.trim()) parts.push(error.message.trim());
  if (typeof error?.response?.message === 'string' && error.response.message.trim()) {
    const responseMessage = error.response.message.trim();
    if (!parts.includes(responseMessage)) parts.push(responseMessage);
  }
  return parts.join(' | ') || 'Unknown Appwrite error';
}

export default function VerifyPage() {
  const [status, setStatus] = useState('Verifying your email...');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    let isActive = true;

    async function run() {
      const params = new URLSearchParams(window.location.search);
      const userId = params.get('userId');
      const secret = params.get('secret');

      if (!userId || !secret) {
        if (isActive) {
          setIsError(true);
          setStatus('Missing verification parameters.');
        }
        return;
      }

      try {
        if (!hasAppwriteConfig || !appwriteAccount) {
          throw new Error('Appwrite is not configured for web UI.');
        }

        try {
          await appwriteAccount.updateVerification({ userId, secret });
        } catch (error) {
          if (!isParamError(error)) {
            throw error;
          }
          await appwriteAccount.updateVerification(userId, secret);
        }

        if (isActive) {
          setIsError(false);
          setStatus('Email verified successfully. You can sign in now.');
        }
      } catch (error) {
        if (isActive) {
          setIsError(true);
          setStatus(formatAppwriteError(error));
        }
      }
    }

    run();

    return () => {
      isActive = false;
    };
  }, []);

  return (
    <main className="relative min-h-screen p-6 grid place-items-center">
      <div className="bg-orb orb-a" />
      <div className="bg-orb orb-b" />

      <section className="w-full max-w-xl auth-card relative z-10">
        <p className="eyebrow">Email Verification</p>
        <h1 className="mt-2 mb-2 text-3xl font-semibold">Appwrite Auth</h1>
        <p className={isError ? 'error !mt-2' : 'note !mt-2'}>{status}</p>
        <div className="mt-5">
          <Link href="/" className="inline-flex primary-btn no-underline">
            Back to login
          </Link>
        </div>
      </section>
    </main>
  );
}
