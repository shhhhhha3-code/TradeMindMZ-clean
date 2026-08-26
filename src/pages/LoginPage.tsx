import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/db/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { Brain, Eye, EyeOff, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  const emailFromUsername = (u: string) => `${u.trim().toLowerCase()}@miaoda.com`;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) { toast.error('Please fill in all fields'); return; }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: emailFromUsername(username),
      password,
    });
    setLoading(false);
    if (error) { toast.error(error.message.includes('Invalid') ? 'Invalid username or password' : error.message); return; }
    toast.success('Welcome back!');
    navigate('/');
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password || !confirmPassword) { toast.error('Please fill in all fields'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { toast.error('Username: letters, digits, and _ only'); return; }
    if (password !== confirmPassword) { toast.error('Passwords do not match'); return; }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    if (!agreed) { toast.error('Please accept the terms and privacy policy'); return; }
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email: emailFromUsername(username),
      password,
      options: { data: { username } },
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Account created! Logging you in...');
    const { error: loginErr } = await supabase.auth.signInWithPassword({
      email: emailFromUsername(username),
      password,
    });
    if (!loginErr) navigate('/');
  };

  return (
    <div className="min-h-screen flex items-stretch">
      {/* Left panel - branding */}
      <div className="hidden md:flex md:w-1/2 flex-col items-center justify-center p-12 relative overflow-hidden"
        style={{ background: 'linear-gradient(135deg, hsl(262,30%,10%) 0%, hsl(225,16%,8%) 100%)' }}>
        <div className="absolute inset-0 opacity-20"
          style={{ backgroundImage: 'radial-gradient(circle at 30% 40%, hsl(262,83%,58%) 0%, transparent 50%), radial-gradient(circle at 70% 70%, hsl(280,70%,50%) 0%, transparent 50%)' }} />
        <div className="relative z-10 text-center max-w-md">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center"
              style={{ background: 'var(--gradient-primary)', boxShadow: 'var(--glow-purple)' }}>
              <Brain className="w-8 h-8 text-white" />
            </div>
            <div className="text-left">
              <h1 className="text-2xl font-bold font-['Space_Grotesk'] text-foreground">TradeMindMZ</h1>
              <p className="text-sm text-muted-foreground">AI Trading Assistant for Pionex</p>
            </div>
          </div>
          <h2 className="text-3xl font-bold text-foreground mb-4 font-['Space_Grotesk']">
            Your AI <span className="gradient-text">Co-Pilot</span> for Crypto
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Analyze markets, discover AI-powered opportunities, and practice trading with 500 USDT of virtual funds — all before risking real money.
          </p>
          <div className="mt-8 grid grid-cols-3 gap-4 text-center">
            {[['AI Signals', 'Real-time analysis'], ['Demo Trading', '500 USDT virtual'], ['Pionex Ready', 'Read-only sync']].map(([title, desc]) => (
              <div key={title} className="p-3 rounded-lg" style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}>
                <div className="text-sm font-semibold text-foreground">{title}</div>
                <div className="text-xs text-muted-foreground mt-1">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel - form */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 md:hidden">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'var(--gradient-primary)' }}>
              <Brain className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold font-['Space_Grotesk'] gradient-text">TradeMindMZ</span>
          </div>

          {/* Tabs */}
          <div className="flex rounded-lg p-1 mb-8" style={{ background: 'hsl(var(--muted))' }}>
            {(['login', 'register'] as const).map(t => (
              <button key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${tab === t ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>
                {t === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          {tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label htmlFor="username" className="text-sm text-foreground mb-1.5 block">Username</Label>
                <Input id="username" value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="Enter your username" autoComplete="username"
                  className="bg-input border-border h-11 px-3" />
              </div>
              <div>
                <Label htmlFor="password" className="text-sm text-foreground mb-1.5 block">Password</Label>
                <div className="relative">
                  <Input id="password" type={showPw ? 'text' : 'password'} value={password}
                    onChange={e => setPassword(e.target.value)} placeholder="Enter your password"
                    autoComplete="current-password" className="bg-input border-border h-11 pr-10 px-3" />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="flex justify-end">
                <Link to="/forgot-password" className="text-sm text-primary hover:underline">Forgot password?</Link>
              </div>
              <Button type="submit" disabled={loading} className="w-full h-11"
                style={{ background: 'var(--gradient-primary)' }}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Sign In
              </Button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <Label htmlFor="reg-username" className="text-sm text-foreground mb-1.5 block">Username</Label>
                <Input id="reg-username" value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="Letters, digits, and _ only" className="bg-input border-border h-11 px-3" />
              </div>
              <div>
                <Label htmlFor="reg-password" className="text-sm text-foreground mb-1.5 block">Password</Label>
                <div className="relative">
                  <Input id="reg-password" type={showPw ? 'text' : 'password'} value={password}
                    onChange={e => setPassword(e.target.value)} placeholder="Min. 8 characters"
                    className="bg-input border-border h-11 pr-10 px-3" />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <Label htmlFor="confirm-password" className="text-sm text-foreground mb-1.5 block">Confirm Password</Label>
                <Input id="confirm-password" type="password" value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter password"
                  className="bg-input border-border h-11 px-3" />
              </div>
              <div className="flex items-start gap-3 pt-1">
                <Checkbox id="terms" checked={agreed} onCheckedChange={v => setAgreed(!!v)}
                  className="mt-0.5 border-border" />
                <label htmlFor="terms" className="text-sm text-muted-foreground leading-relaxed cursor-pointer">
                  I agree to the{' '}
                  <span className="text-primary">Terms of Service</span> and{' '}
                  <span className="text-primary">Privacy Policy</span>. TradeMindMZ provides AI analysis only — not financial advice. Always do your own research.
                </label>
              </div>
              <Button type="submit" disabled={loading} className="w-full h-11"
                style={{ background: 'var(--gradient-primary)' }}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Create Account
              </Button>
            </form>
          )}

          <p className="text-center text-xs text-muted-foreground mt-6">
            TradeMindMZ provides AI-powered market analysis. This is not financial advice. Always do your own research and manage your risk.
          </p>
        </div>
      </div>
    </div>
  );
}
