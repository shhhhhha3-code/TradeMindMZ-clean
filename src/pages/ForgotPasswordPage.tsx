import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/db/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Brain, Loader2, ArrowLeft, Mail } from 'lucide-react';

export default function ForgotPasswordPage() {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username) { toast.error('Please enter your username'); return; }
    setLoading(true);
    const email = `${username.trim().toLowerCase()}@miaoda.com`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    setSent(true);
    toast.success('Password reset instructions sent');
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
          {sent ? (
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Mail className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-xl font-bold mb-2">Check your inbox</h2>
              <p className="text-muted-foreground text-sm mb-6">
                If an account with that username exists, we've sent password reset instructions.
              </p>
              <Link to="/login">
                <Button variant="outline" className="w-full">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Sign In
                </Button>
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-bold mb-2 font-['Space_Grotesk']">Reset Password</h2>
              <p className="text-muted-foreground text-sm mb-6">Enter your username to receive reset instructions.</p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="username" className="text-sm mb-1.5 block">Username</Label>
                  <Input id="username" value={username} onChange={e => setUsername(e.target.value)}
                    placeholder="Your username" className="bg-input border-border h-11 px-3" />
                </div>
                <Button type="submit" disabled={loading} className="w-full h-11"
                  style={{ background: 'var(--gradient-primary)' }}>
                  {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Send Reset Instructions
                </Button>
              </form>
              <div className="mt-4 text-center">
                <Link to="/login" className="text-sm text-muted-foreground hover:text-primary flex items-center justify-center gap-1">
                  <ArrowLeft className="w-3 h-3" /> Back to Sign In
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
