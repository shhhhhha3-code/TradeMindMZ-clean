import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/db/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Brain, Loader2, Eye, EyeOff } from 'lucide-react';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Handle magic link hash from email
    const hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
      supabase.auth.getSession();
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Password updated successfully!');
    navigate('/');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'var(--gradient-primary)' }}>
            <Brain className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-bold font-['Space_Grotesk'] gradient-text">TradeMindMZ</span>
        </div>

        <div className="rounded-xl p-8 border border-border" style={{ background: 'hsl(var(--card))' }}>
          <h2 className="text-xl font-bold mb-2 font-['Space_Grotesk']">Set New Password</h2>
          <p className="text-muted-foreground text-sm mb-6">Enter your new password below.</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="new-pw" className="text-sm mb-1.5 block">New Password</Label>
              <div className="relative">
                <Input id="new-pw" type={showPw ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)} placeholder="Min. 8 characters"
                  className="bg-input border-border h-11 pr-10 px-3" />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <Label htmlFor="confirm-pw" className="text-sm mb-1.5 block">Confirm Password</Label>
              <Input id="confirm-pw" type="password" value={confirm}
                onChange={e => setConfirm(e.target.value)} placeholder="Re-enter new password"
                className="bg-input border-border h-11 px-3" />
            </div>
            <Button type="submit" disabled={loading} className="w-full h-11"
              style={{ background: 'var(--gradient-primary)' }}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Update Password
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
