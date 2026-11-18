import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useMemo, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  Account, ApiError, completePasswordReset, createAccount, requestEmailVerification, requestPasswordReset,
  restoreActiveAccount, signIn, signInWithSocialCredential, signOut, verifyEmail, type SocialCredential,
} from './auth';
import { beginAppleSignIn, beginGoogleSignIn } from './socialSignIn';
import { fetchRewards, redeemReward as submitRewardRedemption, Reward } from './rewardsApi';
import StaffDashboard from './StaffDashboard';
import TournamentBrackets from './TournamentBrackets';
import { cancelEventRsvp, fetchEvents, rsvpToEvent, type AppEvent } from './eventsApi';
import { EVENT_TIME_ZONE } from './easternDateTime';
import { ThemeProvider, useAppTheme } from './theme';

type Tab = 'Events' | 'Bracket' | 'Menu' | 'Rewards' | 'Staff';
type Category = 'All' | 'Food' | 'Drinks';
type AuthMode = 'login' | 'signup' | 'verify' | 'forgot' | 'reset' | 'social_profile';

const tabs: { name: Tab; icon: string }[] = [
  { name: 'Events', icon: '◷' },
  { name: 'Bracket', icon: '▦' },
  { name: 'Menu', icon: '☷' },
  { name: 'Rewards', icon: '☆' },
];
const menu = [
  { id: 'bowl', name: 'Harvest bowl', description: 'Roasted vegetables, quinoa, greens & lemon tahini.', price: '$12.50', category: 'Food', icon: '🥗' },
  { id: 'toast', name: 'Avocado toast', description: 'Sourdough, smashed avocado & a little chili crunch.', price: '$8.50', category: 'Food', icon: '🥑' },
  { id: 'croissant', name: 'Butter croissant', description: 'Flaky, golden layers. Baked fresh every morning.', price: '$4.00', category: 'Food', icon: '🥐' },
  { id: 'latte', name: 'House latte', description: 'Our signature espresso with your choice of milk.', price: '$5.00', category: 'Drinks', icon: '☕' },
  { id: 'matcha', name: 'Iced matcha', description: 'Smooth matcha, oat milk & a touch of vanilla.', price: '$5.50', category: 'Drinks', icon: '🍵' },
  { id: 'lemonade', name: 'Fresh lemonade', description: 'Fresh-squeezed lemons. A sunny little pick-me-up.', price: '$4.50', category: 'Drinks', icon: '🍋' },
];
export default function App() {
  return <SafeAreaProvider><ThemeProvider><LoyaltyApp /></ThemeProvider></SafeAreaProvider>;
}

function LoyaltyApp() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState('');

  async function loadAccount() {
    setLoading(true);
    setStartupError('');
    try {
      setAccount(await restoreActiveAccount());
    } catch (error) {
      console.error('Unable to restore the API session.', error);
      setStartupError('We could not connect to your account. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAccount();
  }, []);

  if (loading) {
    return <LoadingScreen message="Connecting to Green Fork..." />;
  }

  if (startupError !== '') {
    return <StartupErrorScreen message={startupError} onRetry={() => void loadAccount()} />;
  }

  if (!account) {
    return <AuthScreen onAuthenticated={setAccount} />;
  }

  return (
    <MemberApp
      account={account}
      onSignOut={async () => {
        await signOut();
        setAccount(null);
      }}
    />
  );
}

function LoadingScreen({ message }: { message: string }) {
  const { colors } = useAppTheme();
  const styles = useAppStyles();
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.authCentered}>
        <ActivityIndicator size="large" color={colors.brand} />
        <Text style={styles.authSubtitle}>{message}</Text>
      </View>
    </SafeAreaView>
  );
}

function StartupErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const styles = useAppStyles();
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.authCentered}>
        <Text accessibilityRole="header" style={styles.authTitle}>We hit a snag.</Text>
        <Text style={styles.authSubtitle}>{message}</Text>
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.button}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (account: Account) => void }) {
  const { colors, scheme } = useAppTheme();
  const styles = useAppStyles();
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [pendingSocialCredential, setPendingSocialCredential] = useState<SocialCredential | null>(null);

  async function submit() {
    const normalizedEmail = email.trim();
    if (mode !== 'social_profile' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if ((mode === 'signup' || mode === 'social_profile') && name.trim() === '') {
      setError(mode === 'signup' ? 'Enter your name to create an account.' : 'Enter your name to finish your account.');
      return;
    }
    if ((mode === 'signup' || mode === 'login' || mode === 'reset') && (password.length < 8 || password.length > 128)) {
      setError('Use a password between 8 and 128 characters.');
      return;
    }
    if ((mode === 'verify' || mode === 'reset') && !/^\d{8}$/.test(code.trim())) {
      setError('Enter the 8-digit code from your email.');
      return;
    }

    setPending(true);
    setError('');
    setNotice('');
    try {
      switch (mode) {
        case 'signup':
          await createAccount(name.trim(), normalizedEmail, password);
          setMode('verify');
          setNotice('If this address can be registered, a verification code has been sent.');
          break;
        case 'verify':
          await verifyEmail(normalizedEmail, code.trim());
          setMode('login');
          setCode('');
          setNotice('Email verified. You can now sign in.');
          break;
        case 'login':
          onAuthenticated(await signIn(normalizedEmail, password));
          break;
        case 'forgot':
          await requestPasswordReset(normalizedEmail);
          setMode('reset');
          setNotice('If an eligible account exists, a password reset code has been sent.');
          break;
        case 'reset':
          await completePasswordReset(normalizedEmail, code.trim(), password);
          setMode('login');
          setCode('');
          setPassword('');
          setNotice('Your password has been reset. Sign in with the new password.');
          break;
        case 'social_profile':
          if (!pendingSocialCredential) {
            setMode('login');
            throw new ApiError(400, 'social_sign_in_expired', 'Restart sign-in to continue.');
          }
          onAuthenticated(await signInWithSocialCredential({
            ...pendingSocialCredential,
            name: name.trim(),
          }));
          setPendingSocialCredential(null);
          break;
      }
    } catch (caughtError) {
      if (caughtError instanceof ApiError) {
        if (caughtError.code === 'email_verification_required') setMode('verify');
        if (caughtError.code === 'social_nonce_invalid') {
          setPendingSocialCredential(null);
          setMode('login');
          setError('Your sign-in expired. Please start again.');
          return;
        }
        setError(caughtError.message);
      } else {
        console.error('Unable to complete account authentication.', caughtError);
        setError('We could not complete that request. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    if (nextMode !== 'social_profile') setPendingSocialCredential(null);
    setError('');
    setNotice('');
  }

  async function beginSocialLogin(provider: 'google' | 'apple') {
    setPending(true);
    setError('');
    setNotice('');
    try {
      const credential = provider === 'google'
        ? await beginGoogleSignIn()
        : await beginAppleSignIn();
      if (!credential) return;
      try {
        onAuthenticated(await signInWithSocialCredential(credential));
      } catch (caughtError) {
        if (caughtError instanceof ApiError && caughtError.code === 'display_name_required') {
          setPendingSocialCredential(credential);
          setName(credential.name ?? '');
          setMode('social_profile');
          setNotice('Add your name to finish creating your account.');
          return;
        }
        throw caughtError;
      }
    } catch (caughtError) {
      if (caughtError instanceof ApiError) {
        setError(caughtError.message);
      } else {
        console.error(`Unable to complete ${provider} sign-in.`);
        setError('We could not complete that sign-in. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  async function resendVerificationCode() {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await requestEmailVerification(email.trim());
      setNotice('If this account needs verification, a code has been sent.');
    } catch (caughtError) {
      if (caughtError instanceof ApiError) setError(caughtError.message);
      else {
        console.error('Unable to request an email verification code.', caughtError);
        setError('We could not send a code. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <KeyboardAvoidingView style={styles.authKeyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authShell}>
            <View style={styles.brand}>
              <View style={styles.logo}><Text style={styles.logoText}>g.</Text></View>
              <View>
                <Text style={styles.brandName}>green fork</Text>
                <Text style={styles.brandCaption}>GOOD FOOD. LITTLE PERKS.</Text>
              </View>
            </View>
            <Text style={styles.authEyebrow}>YOUR NEIGHBORHOOD, REWARDED</Text>
            <Text accessibilityRole="header" style={styles.authTitle}>
              {mode === 'login' ? 'Welcome back.'
                : mode === 'signup' ? 'Make yourself at home.'
                  : mode === 'verify' ? 'Check your inbox.'
                    : mode === 'forgot' ? 'Reset your password.'
                      : mode === 'reset' ? 'Choose a new password.'
                        : 'Finish your profile.'}
            </Text>
            <Text style={styles.authSubtitle}>
              {mode === 'login' ? 'Sign in to pick up where the good stuff begins.'
                : mode === 'signup' ? 'Create an account to join the Green Fork community.'
                  : mode === 'verify' ? 'Enter the verification code sent to your email address.'
                    : mode === 'forgot' ? 'We’ll email you a code if the account is eligible for a reset.'
                      : mode === 'reset' ? 'Enter the code from your email and choose a new password.'
                        : 'Your provider did not share a name. Add one to continue.'}
            </Text>

            <View style={styles.authCard}>
              {(mode === 'signup' || mode === 'social_profile') && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Name</Text>
                  <TextInput
                    accessibilityLabel="Name"
                    autoCapitalize="words"
                    autoComplete="name"
                    onChangeText={setName}
                    placeholder="Your name"
                    placeholderTextColor={colors.muted}
                    returnKeyType="next"
                    style={styles.textInput}
                    value={name}
                  />
                </View>
              )}
              {mode !== 'social_profile' && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Email</Text>
                  <TextInput
                    accessibilityLabel="Email"
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={colors.muted}
                    returnKeyType="next"
                    style={styles.textInput}
                    textContentType="emailAddress"
                    value={email}
                  />
                </View>
              )}
              {(mode === 'verify' || mode === 'reset') && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Email code</Text>
                  <TextInput
                    accessibilityLabel="Email code"
                    autoCapitalize="none"
                    keyboardType="number-pad"
                    maxLength={8}
                    onChangeText={setCode}
                    placeholder="8-digit code"
                    placeholderTextColor={colors.muted}
                    style={styles.textInput}
                    textContentType="oneTimeCode"
                    value={code}
                  />
                </View>
              )}
              {(mode === 'login' || mode === 'signup' || mode === 'reset') && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>{mode === 'reset' ? 'New password' : 'Password'}</Text>
                  <TextInput
                    accessibilityLabel={mode === 'reset' ? 'New password' : 'Password'}
                    autoCapitalize="none"
                    autoComplete={mode === 'signup' || mode === 'reset' ? 'new-password' : 'current-password'}
                    onChangeText={setPassword}
                    onSubmitEditing={() => void submit()}
                    placeholder={mode === 'login' ? 'Your password' : '8–128 characters'}
                    placeholderTextColor={colors.muted}
                    returnKeyType="go"
                    secureTextEntry
                    style={styles.textInput}
                    textContentType={mode === 'signup' || mode === 'reset' ? 'newPassword' : 'password'}
                    value={password}
                  />
                </View>
              )}
              {notice !== '' && <Text accessibilityLiveRegion="polite" style={styles.authNotice}>{notice}</Text>}
              {error !== '' && <Text accessibilityLiveRegion="polite" style={styles.authError}>{error}</Text>}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: pending }}
                disabled={pending}
                onPress={() => void submit()}
                style={({ pressed }) => [styles.button, pending && styles.pendingButton, pressed && styles.pressed]}
              >
                {pending
                  ? <ActivityIndicator color={colors.brandText} />
                  : <Text style={styles.buttonText}>
                    {mode === 'login' ? 'Sign in'
                      : mode === 'signup' ? 'Create account'
                        : mode === 'verify' ? 'Verify email'
                          : mode === 'forgot' ? 'Send reset code'
                            : mode === 'reset' ? 'Reset password'
                              : 'Continue'}
                  </Text>}
              </Pressable>
              {mode === 'login' && Platform.OS !== 'web' && (
                <View style={styles.socialGroup}>
                  <Text style={styles.fieldLabel}>OR SIGN IN WITH</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: pending }}
                    disabled={pending}
                    onPress={() => void beginSocialLogin('google')}
                    style={({ pressed }) => [styles.socialButton, pending && styles.pendingButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.socialButtonText}>Continue with Google</Text>
                  </Pressable>
                  {Platform.OS === 'ios' && (
                    <AppleAuthentication.AppleAuthenticationButton
                      accessibilityLabel="Sign in with Apple"
                      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                      buttonStyle={scheme === 'dark'
                        ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                        : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                      cornerRadius={12}
                      onPress={() => {
                        if (!pending) void beginSocialLogin('apple');
                      }}
                      style={styles.appleButton}
                    />
                  )}
                </View>
              )}
              {mode === 'login' && (
                <>
                  <Pressable accessibilityRole="button" disabled={pending} onPress={() => changeMode('forgot')} style={styles.authSwitch}>
                    <Text style={styles.authSwitchText}>Forgot your password?</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={pending} onPress={() => changeMode('verify')} style={styles.authSwitch}>
                    <Text style={styles.authSwitchText}>Need a verification code?</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={pending} onPress={() => changeMode('signup')} style={styles.authSwitch}>
                    <Text style={styles.authSwitchText}>New to Green Fork? Create an account</Text>
                  </Pressable>
                </>
              )}
              {mode === 'signup' && (
                <Pressable accessibilityRole="button" disabled={pending} onPress={() => changeMode('login')} style={styles.authSwitch}>
                  <Text style={styles.authSwitchText}>Already a member? Sign in</Text>
                </Pressable>
              )}
              {mode === 'social_profile' && (
                <Pressable accessibilityRole="button" disabled={pending} onPress={() => changeMode('login')} style={styles.authSwitch}>
                  <Text style={styles.authSwitchText}>Cancel and return to sign in</Text>
                </Pressable>
              )}
              {mode === 'verify' && (
                <>
                  <Pressable accessibilityRole="button" disabled={pending} onPress={() => void resendVerificationCode()} style={styles.authSwitch}>
                    <Text style={styles.authSwitchText}>Resend verification code</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={pending} onPress={() => changeMode('login')} style={styles.authSwitch}>
                    <Text style={styles.authSwitchText}>Back to sign in</Text>
                  </Pressable>
                </>
              )}
              {(mode === 'forgot' || mode === 'reset') && (
                <Pressable accessibilityRole="button" disabled={pending} onPress={() => changeMode(mode === 'reset' ? 'forgot' : 'login')} style={styles.authSwitch}>
                  <Text style={styles.authSwitchText}>{mode === 'reset' ? 'Request another code' : 'Back to sign in'}</Text>
                </Pressable>
              )}
            </View>
            <Text style={styles.authFootnote}>Sign-in and reward balances are managed securely by Green Fork.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MemberApp({ account, onSignOut }: { account: Account; onSignOut: () => Promise<void> }) {
  const {
    colors, scheme, preference, preferenceReady, preferenceSaving, preferenceError, setPreference,
  } = useAppTheme();
  const styles = useAppStyles();
  const [tab, setTab] = useState<Tab>('Events');
  const [category, setCategory] = useState<Category>('All');
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [rsvpPendingId, setRsvpPendingId] = useState<string | null>(null);
  const [points, setPoints] = useState(account.rewardPoints);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loadingRewards, setLoadingRewards] = useState(true);
  const [redeemed, setRedeemed] = useState<string[]>([]);
  const [selectedReward, setSelectedReward] = useState<Reward | null>(null);
  const [notice, setNotice] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redemptionRequest, setRedemptionRequest] = useState<{ rewardId: string; key: string } | null>(null);

  useEffect(() => {
    let active = true;
    if (tab !== 'Events') return () => { active = false; };
    setLoadingEvents(true);
    fetchEvents()
      .then(items => { if (active) setEvents(items); })
      .catch(error => {
        console.error('Unable to load events from the API.', error);
        if (active) setNotice(error instanceof ApiError ? error.message : 'We could not load events. Please try again later.');
      })
      .finally(() => { if (active) setLoadingEvents(false); });
    return () => { active = false; };
  }, [tab]);

  useEffect(() => {
    let active = true;
    fetchRewards()
      .then(items => {
        if (active) setRewards(items);
      })
      .catch(error => {
        console.error('Unable to load rewards from the API.', error);
        if (active) setNotice('We could not load rewards. Please try again later.');
      })
      .finally(() => {
        if (active) setLoadingRewards(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function toggleReservation(event: AppEvent) {
    const occurrenceKey = `${event.id}:${event.occurrenceStart}`;
    setRsvpPendingId(occurrenceKey);
    setNotice('');
    try {
      if (event.reserved) await cancelEventRsvp(event.id, event.occurrenceStart);
      else await rsvpToEvent(event.id, event.occurrenceStart);
      setEvents(await fetchEvents());
      setNotice(event.reserved ? 'Your RSVP was canceled.' : 'You’re on the guest list!');
    } catch (error) {
      console.error('Unable to update the event RSVP.', error);
      setNotice(error instanceof ApiError ? error.message : 'We could not update your RSVP. Please try again.');
    } finally {
      setRsvpPendingId(null);
    }
  }

  async function redeemReward() {
    if (!selectedReward || points < selectedReward.pointsCost || redeemed.includes(selectedReward.id) || redeeming) return;
    const reward = selectedReward;
    const idempotencyKey = redemptionRequest?.rewardId === reward.id
      ? redemptionRequest.key
      : Crypto.randomUUID();
    setRedeeming(true);
    setRedemptionRequest({ rewardId: reward.id, key: idempotencyKey });
    try {
      const redemption = await submitRewardRedemption(reward.id, idempotencyKey);
      setPoints(redemption.rewardPoints);
      setRedeemed(current => [...current, reward.id]);
      setNotice(redemption.alreadyApplied
        ? `${reward.name} was already redeemed. Your balance has been refreshed.`
        : `${reward.name} redeemed. No real voucher was issued in this prototype.`);
      setSelectedReward(null);
      setRedemptionRequest(null);
    } catch (error) {
      console.error('Unable to save the reward redemption.', error);
      setNotice(error instanceof ApiError ? error.message : 'We could not save this redemption. Please try again.');
    } finally {
      setRedeeming(false);
    }
  }

  const visibleTabs = account.role === 'member'
    ? tabs
    : [...tabs, { name: 'Staff' as const, icon: '⚙' }];

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <View style={styles.shell}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={styles.logo}><Text style={styles.logoText}>g.</Text></View>
            <View>
              <Text style={styles.brandName}>green fork</Text>
              <Text style={styles.brandCaption}>GOOD FOOD. LITTLE PERKS.</Text>
            </View>
          </View>
          <View style={styles.memberActions}>
            <Text numberOfLines={1} style={styles.memberText}>☆ {account.name}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void onSignOut().catch(error => {
                  console.error('Unable to sign out of the local account.', error);
                  setNotice('We could not sign out. Please try again.');
                });
              }}
              style={styles.signOutButton}
            >
              <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView key={tab} contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>YOUR NEIGHBORHOOD, REWARDED</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {tab === 'Events' ? 'Good things are happening.'
              : tab === 'Bracket' ? 'Let the games begin.'
                : tab === 'Menu' ? 'Fresh favorites, made for you.'
                  : tab === 'Rewards' ? 'A little thank you, from us.' : 'Staff workspace.'}
          </Text>
          <Text style={styles.subtitle}>
            {tab === 'Events' ? 'Pull up a chair. There’s always something to look forward to.'
              : tab === 'Bracket' ? 'Weekly pool tournament brackets, linked to event RSVPs.'
                : tab === 'Menu' ? 'Simple ingredients. Thoughtful flavors. Find your next favorite.'
                  : tab === 'Rewards' ? 'Every visit brings you closer to something delicious.'
                    : 'Member support, event operations, and program reporting.'}
          </Text>

          {notice !== '' && (
            <View style={styles.notice}>
              <Text accessibilityLiveRegion="polite" style={styles.noticeText}>{notice}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Dismiss notification" onPress={() => setNotice('')} style={styles.dismiss}>
                <Text style={styles.noticeText}>✕</Text>
              </Pressable>
            </View>
          )}

          {tab === 'Events' && (
            <>
              <View style={styles.feature}>
                <Text style={styles.featureIcon} accessible={false}>✦</Text>
                <Text style={styles.featureTitle}>More than a place to eat.</Text>
                <Text style={styles.featureText}>A place to belong. Explore what’s coming up at Green Fork.</Text>
              </View>
              <View style={styles.sectionHeading}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>Upcoming events</Text>
                <Text style={styles.muted}>{events.length} to look forward to</Text>
              </View>
              {loadingEvents && <ActivityIndicator color={colors.brand} />}
              {!loadingEvents && events.length === 0 && <Text style={styles.muted}>No upcoming events are available right now.</Text>}
              {events.map(event => {
                const reserved = event.reserved;
                const startsAt = new Date(event.startsAt);
                const month = startsAt.toLocaleString('en-US', { month: 'short', timeZone: EVENT_TIME_ZONE }).toUpperCase();
                const day = startsAt.toLocaleString('en-US', { day: 'numeric', timeZone: EVENT_TIME_ZONE });
                const date = startsAt.toLocaleDateString('en-US', {
                  weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: EVENT_TIME_ZONE,
                });
                const time = startsAt.toLocaleTimeString('en-US', {
                  hour: 'numeric', minute: '2-digit', timeZone: EVENT_TIME_ZONE, timeZoneName: 'short',
                });
                const occurrenceKey = `${event.id}:${event.occurrenceStart}`;
                const full = event.capacity !== null && event.attendeeCount >= event.capacity && !reserved;
                const closed = !event.rsvpOpen && !reserved;
                return (
                  <View key={occurrenceKey} style={styles.card}>
                    <View style={styles.eventTop}>
                      <View style={styles.dateBadge}>
                        <Text style={styles.dateMonth}>{month}</Text>
                        <Text style={styles.dateDay}>{day}</Text>
                      </View>
                      <Text style={styles.tag}>{event.tag}</Text>
                    </View>
                    <Text accessibilityRole="header" style={styles.cardTitle}>{event.title}</Text>
                    <Text style={styles.eventTime}>{date} · {time}</Text>
                    {event.recurrence !== 'none' && (
                      <Text style={styles.muted}>Part of a {event.recurrence} series · RSVP for this date</Text>
                    )}
                    <Text style={styles.description}>{event.description}</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${reserved ? 'Cancel reservation for' : 'RSVP to'} ${event.title} on ${date}`}
                      accessibilityState={{ disabled: rsvpPendingId === occurrenceKey || closed || full }}
                      disabled={rsvpPendingId === occurrenceKey || closed || full}
                      onPress={() => void toggleReservation(event)}
                      style={({ pressed }) => [styles.button, (reserved || closed || full) && styles.secondaryButton, pressed && styles.pressed]}
                    >
                      <Text style={[styles.buttonText, (reserved || closed || full) && styles.secondaryButtonText]}>
                        {reserved ? 'You’re going · Cancel RSVP' : closed ? 'RSVPs closed' : full ? 'Event is full' : 'Count me in  →'}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </>
          )}

          {tab === 'Bracket' && <TournamentBrackets account={account} />}

          {tab === 'Menu' && (
            <>
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>Appearance</Text>
                <Text style={styles.description}>Choose how Green Fork looks. The system option follows your device setting.</Text>
                <View style={styles.filters}>
                  {([
                    ['system', 'System'],
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                  ] as const).map(([value, label]) => (
                    <Pressable
                      key={value}
                      accessibilityRole="button"
                      accessibilityState={{ selected: preference === value, disabled: !preferenceReady || preferenceSaving }}
                      disabled={!preferenceReady || preferenceSaving}
                      onPress={() => void setPreference(value)}
                      style={[styles.filter, preference === value && styles.activeFilter]}
                    >
                      <Text style={[styles.filterText, preference === value && styles.activeFilterText]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                {preferenceSaving && <ActivityIndicator color={colors.brand} />}
                {preferenceError !== '' && (
                  <Text accessibilityLiveRegion="polite" style={styles.authError}>{preferenceError}</Text>
                )}
              </View>
              <View style={styles.filters}>
                {(['All', 'Food', 'Drinks'] as Category[]).map(item => (
                  <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: item === category }}
                    onPress={() => setCategory(item)} style={[styles.filter, item === category && styles.activeFilter]}>
                    <Text style={[styles.filterText, item === category && styles.activeFilterText]}>{item}</Text>
                  </Pressable>
                ))}
              </View>
              {menu.filter(item => category === 'All' || item.category === category).map(item => (
                <View key={item.id} style={styles.menuCard}>
                  <View style={styles.menuArtwork}><Text style={styles.menuIcon} accessible={false}>{item.icon}</Text></View>
                  <View style={styles.menuDetails}>
                    <Text accessibilityRole="header" style={styles.cardTitle}>{item.name}</Text>
                    <Text style={styles.description}>{item.description}</Text>
                    <Text style={styles.price}>{item.price}</Text>
                  </View>
                </View>
              ))}
              <Text style={styles.footnote}>Sample menu · USD prices. Ask our team about allergens before ordering.</Text>
            </>
          )}

          {tab === 'Rewards' && (
            <>
              <View style={styles.pointsCard}>
                <Text style={styles.pointsLabel}>YOUR POINTS BALANCE</Text>
                <Text style={styles.points}>{points}<Text style={styles.pointsUnit}> points</Text></Text>
                <Text style={styles.featureText}>Little visits. Lovely rewards.</Text>
                <View accessibilityRole="progressbar" accessibilityLabel="Progress toward the lunch reward"
                  accessibilityValue={{ min: 0, max: 250, now: points }} style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.min(points / 250 * 100, 100)}%` }]} />
                </View>
                <Text style={styles.featureText}>{Math.max(250 - points, 0)} points to a lunch on us</Text>
              </View>
              <Text accessibilityRole="header" style={styles.sectionTitle}>Pick your next perk</Text>
              {loadingRewards && <ActivityIndicator color={colors.brand} />}
              {rewards.map(reward => {
                const claimed = redeemed.includes(reward.id);
                const available = points >= reward.pointsCost && !claimed;
                return (
                  <View key={reward.id} style={styles.card}>
                    <View style={styles.rewardHeading}>
                      <Text style={styles.eventIcon} accessible={false}>{reward.icon}</Text>
                      <View style={styles.rewardDetails}>
                        <Text style={styles.cardTitle}>{reward.name}</Text>
                        <Text style={styles.price}>{reward.pointsCost} points</Text>
                      </View>
                    </View>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Redeem ${reward.name}`}
                      accessibilityState={{ disabled: !available }} disabled={!available}
                      onPress={() => setSelectedReward(reward)}
                      style={({ pressed }) => [styles.button, !available && styles.disabledButton, pressed && styles.pressed]}>
                      <Text style={[styles.buttonText, !available && styles.disabledButtonText]}>
                        {claimed ? 'Redeemed ✓' : available ? 'Redeem reward  →' : `${reward.pointsCost - points} more points to unlock`}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
              <View style={styles.howItWorks}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>Good food comes full circle.</Text>
                <Text style={styles.description}>Our sample program earns 10 points per $1 spent. In a live program, purchases would be verified in store before points are awarded.</Text>
              </View>
            </>
          )}
          {tab === 'Staff' && account.role !== 'member' && <StaffDashboard account={account} />}
          <Text style={styles.footnote}>Sample menu.{'\n'}Accounts, events, rewards, points, redemptions, and RSVPs are server-managed.</Text>
        </ScrollView>

        <View accessibilityRole="tablist" style={styles.tabBar}>
          {visibleTabs.map(item => (
            <Pressable key={item.name} accessibilityRole="tab" accessibilityState={{ selected: tab === item.name }}
              onPress={() => { setTab(item.name); setNotice(''); }}
              style={({ pressed }) => [styles.tab, tab === item.name && styles.activeTab, pressed && styles.pressed]}>
              <Text accessible={false} style={[styles.tabIcon, tab === item.name && styles.activeTabText]}>{item.icon}</Text>
              <Text style={[styles.tabText, tab === item.name && styles.activeTabText]}>{item.name}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Modal visible={selectedReward !== null} transparent animationType="fade" onRequestClose={() => setSelectedReward(null)}>
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={styles.modalCard}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Enjoy a little perk?</Text>
            <Text style={styles.description}>Redeem {selectedReward?.name} for {selectedReward?.pointsCost} points? No real voucher is issued in this prototype.</Text>
            <Pressable accessibilityRole="button" disabled={redeeming} onPress={() => void redeemReward()} style={[styles.button, redeeming && styles.pendingButton]}>
              {redeeming ? <ActivityIndicator color={colors.brandText} /> : <Text style={styles.buttonText}>Confirm redemption</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setSelectedReward(null)} style={[styles.button, styles.secondaryButton]}>
              <Text style={styles.secondaryButtonText}>Not right now</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function useAppStyles() {
  const { colors } = useAppTheme();
  return useMemo(() => StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.background },
    authKeyboard: { flex: 1 },
    authScroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    authShell: { width: '100%', maxWidth: 480, alignSelf: 'center', gap: 16 },
    authCentered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
    authEyebrow: { fontSize: 10, fontWeight: '700', color: colors.muted, letterSpacing: 1.8, marginTop: 20 },
    authTitle: { fontSize: 34, lineHeight: 40, fontWeight: '700', color: colors.text, letterSpacing: -1 },
    authSubtitle: { color: colors.muted, fontSize: 15, lineHeight: 23, textAlign: 'center' },
    authCard: { backgroundColor: colors.surface, borderRadius: 18, padding: 20, borderWidth: 1, borderColor: colors.border, gap: 16, marginTop: 8 },
    socialGroup: { gap: 10 },
    socialButton: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    socialButtonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
    appleButton: { width: '100%', height: 48 },
    fieldGroup: { gap: 7 },
    fieldLabel: { color: colors.brandAccent, fontSize: 13, fontWeight: '600' },
    textInput: { backgroundColor: colors.inputBackground, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, minHeight: 50, fontSize: 15 },
    authError: { color: colors.danger, fontSize: 13, lineHeight: 19 },
    authNotice: { color: colors.brandAccent, fontSize: 13, lineHeight: 19 },
    authSwitch: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
    authSwitchText: { color: colors.brandAccent, fontSize: 13, fontWeight: '600', textAlign: 'center' },
    authFootnote: { color: colors.muted, fontSize: 11, textAlign: 'center', lineHeight: 18 },
    pendingButton: { opacity: 0.75 },
    shell: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
    header: { padding: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12 },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
    logo: { backgroundColor: colors.brand, width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
    logoText: { fontSize: 30, fontWeight: '700', color: colors.brandText, marginTop: -4 },
    brandName: { color: colors.brandAccent, fontSize: 24, fontWeight: '700', letterSpacing: -1 },
    brandCaption: { color: colors.muted, fontSize: 8, letterSpacing: 1.4, marginTop: 3 },
    memberActions: { alignItems: 'flex-end', gap: 6, flexShrink: 1 },
    memberText: { color: colors.text, fontSize: 12, fontWeight: '600', maxWidth: 120 },
    signOutButton: { backgroundColor: colors.subtleButton, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 16 },
    signOutText: { color: colors.subtleButtonText, fontSize: 11, fontWeight: '600' },
    content: { padding: 22, paddingBottom: 30, gap: 16 },
    eyebrow: { fontSize: 10, fontWeight: '700', color: colors.muted, letterSpacing: 1.8, marginTop: 10 },
    title: { fontSize: 34, lineHeight: 40, fontWeight: '700', color: colors.text, letterSpacing: -1 },
    subtitle: { color: colors.muted, fontSize: 15, lineHeight: 23 },
    feature: { backgroundColor: colors.brand, borderRadius: 20, padding: 24, marginVertical: 8, gap: 10 },
    featureIcon: { color: colors.progressFill, fontSize: 32 },
    featureTitle: { color: colors.brandText, fontSize: 24, fontWeight: '600' },
    featureText: { color: colors.onBrandMuted, fontSize: 14, lineHeight: 21 },
    sectionHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
    muted: { color: colors.muted, fontSize: 12 },
    card: { backgroundColor: colors.surface, borderRadius: 18, padding: 20, borderWidth: 1, borderColor: colors.border, gap: 12 },
    eventTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    dateBadge: { backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 10, minWidth: 56, alignItems: 'center' },
    dateMonth: { fontSize: 10, color: colors.brandAccent, fontWeight: '700', letterSpacing: 1 },
    dateDay: { fontSize: 26, color: colors.brandAccent, fontWeight: '700' },
    tag: { color: colors.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1, flex: 1 },
    eventIcon: { fontSize: 36 },
    cardTitle: { color: colors.text, fontSize: 19, fontWeight: '600' },
    eventTime: { color: colors.brandAccent, fontSize: 12, fontWeight: '500' },
    description: { color: colors.muted, fontSize: 14, lineHeight: 22 },
    button: { backgroundColor: colors.brand, borderRadius: 12, padding: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    buttonText: { color: colors.brandText, fontSize: 14, fontWeight: '600' },
    secondaryButton: { backgroundColor: colors.brandSoft },
    secondaryButtonText: { color: colors.brandSoftText, fontSize: 14, fontWeight: '600' },
    pressed: { opacity: 0.7 },
    notice: { backgroundColor: colors.brandSoft, borderRadius: 12, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
    noticeText: { color: colors.brandSoftText, fontSize: 13, lineHeight: 20, flexShrink: 1 },
    dismiss: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginLeft: 'auto' },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginVertical: 8 },
    filter: { paddingHorizontal: 22, paddingVertical: 12, minHeight: 44, borderRadius: 24, backgroundColor: colors.subtleButton },
    activeFilter: { backgroundColor: colors.brand },
    filterText: { color: colors.subtleButtonText, fontWeight: '600', fontSize: 14 },
    activeFilterText: { color: colors.brandText },
    menuCard: { flexDirection: 'row', gap: 16, alignItems: 'center', backgroundColor: colors.surface, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: colors.border },
    menuArtwork: { width: 76, height: 90, backgroundColor: colors.surfaceAlt, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
    menuIcon: { fontSize: 42 },
    menuDetails: { flex: 1, gap: 6 },
    price: { color: colors.brandAccent, fontSize: 14, fontWeight: '700' },
    pointsCard: { backgroundColor: colors.brand, borderRadius: 20, padding: 24, gap: 12, marginVertical: 8 },
    pointsLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, color: colors.onBrandMuted },
    points: { color: colors.brandText, fontSize: 56, fontWeight: '700' },
    pointsUnit: { color: colors.onBrandMuted, fontSize: 18, fontWeight: '400' },
    progressTrack: { backgroundColor: colors.progressTrack, borderRadius: 6, height: 8, overflow: 'hidden', marginTop: 8 },
    progressFill: { backgroundColor: colors.progressFill, height: '100%', borderRadius: 6 },
    rewardHeading: { flexDirection: 'row', gap: 16, alignItems: 'center' },
    rewardDetails: { flex: 1, gap: 6 },
    disabledButton: { backgroundColor: colors.disabledBackground },
    disabledButtonText: { color: colors.disabledText },
    howItWorks: { padding: 8, gap: 10 },
    footnote: { color: colors.muted, fontSize: 11, textAlign: 'center', lineHeight: 18, marginTop: 8 },
    tabBar: { flexDirection: 'row', padding: 10, gap: 8, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
    tab: { flex: 1, alignItems: 'center', padding: 10, gap: 4, borderRadius: 14 },
    activeTab: { backgroundColor: colors.brandSoft },
    tabIcon: { color: colors.muted, fontSize: 24 },
    tabText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
    activeTabText: { color: colors.brandAccent },
    modalBackdrop: { flex: 1, backgroundColor: colors.overlay, alignItems: 'center', justifyContent: 'center', padding: 24 },
    modalCard: { backgroundColor: colors.surface, borderRadius: 20, padding: 24, gap: 16, width: '100%', maxWidth: 400 },
  }), [colors]);
}
