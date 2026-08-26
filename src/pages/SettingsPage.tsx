import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { supabase } from '@/db/supabase';
import { updateProfile, getUserSettings, updateUserSettings } from '@/db/api';
import type { UserSettings } from '@/types/types';
import { User, Bell, Loader2, Eye, EyeOff, Shield } from 'lucide-react';

export default function SettingsPage() {
  const { user, profile, refreshProfile } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPw, setSavingPw] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    if (profile) setDisplayName(profile.display_name ?? profile.username ?? '');
    if (user) getUserSettings(user.id).then(s => setSettings(s));
  }, [profile, user]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSavingProfile(true);
    try {
      await updateProfile(user.id, { display_name: displayName });
      await refreshProfile();
      toast.success('Profile updated');
    } catch { toast.error('Failed to update profile'); }
    finally { setSavingProfile(false); }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setSavingPw(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPw(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Password updated');
    setNewPassword('');
  };

  const handleToggleSetting = async (key: keyof UserSettings, value: boolean) => {
    if (!user || !settings) return;
    // Optimistic update — show new value immediately
    const previous = settings;
    setSettings({ ...settings, [key]: value });
    setSavingSettings(true);
    try {
      await updateUserSettings(user.id, { [key]: value } as Partial<Pick<UserSettings, 'email_notifications' | 'signal_alerts' | 'trade_alerts'>>);
      toast.success('Notification preference saved');
    } catch (err) {
      // Roll back on failure, show real error
      setSettings(previous);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to save setting: ${msg}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const username = profile?.username ?? user?.email?.split('@')[0] ?? '';

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold font-['Space_Grotesk'] text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your account and preferences</p>
      </div>

      {/* Profile */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <User className="w-4 h-4 text-primary" /> Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div>
              <Label className="text-xs font-medium mb-1.5 block">Username (cannot be changed)</Label>
              <Input value={username} disabled className="bg-muted border-border h-10 px-3 text-sm opacity-60" />
            </div>
            <div>
              <Label className="text-xs font-medium mb-1.5 block">Display Name</Label>
              <Input value={displayName} onChange={e => setDisplayName(e.target.value)}
                placeholder="How you appear in the app" className="bg-input border-border h-10 px-3 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium mb-1.5 block">Email (linked to account)</Label>
              <Input value={user?.email ?? ''} disabled className="bg-muted border-border h-10 px-3 text-sm opacity-60" />
            </div>
            <Button type="submit" disabled={savingProfile} size="sm" style={{ background: 'var(--gradient-primary)' }}>
              {savingProfile && <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />}
              Save Profile
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Security */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" /> Security
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div>
              <Label className="text-xs font-medium mb-1.5 block">New Password</Label>
              <div className="relative">
                <Input type={showPw ? 'text' : 'password'} value={newPassword}
                  onChange={e => setNewPassword(e.target.value)} placeholder="Minimum 8 characters"
                  className="bg-input border-border h-10 px-3 pr-10 text-sm" />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <Button type="submit" disabled={savingPw || !newPassword} size="sm" variant="outline">
              {savingPw && <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />}
              Change Password
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Notifications */}
      {settings && (
        <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Bell className="w-4 h-4 text-primary" /> Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {([
              ['email_notifications', 'Email Notifications', 'Receive summary emails about your account'],
              ['signal_alerts', 'AI Signal Alerts', 'Get notified when new high-confidence signals appear'],
              ['trade_alerts', 'Trade Alerts', 'Get notified when demo trades hit TP/SL levels'],
            ] as [keyof UserSettings, string, string][]).map(([key, title, desc]) => (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                </div>
                <Switch checked={!!settings[key]} onCheckedChange={v => handleToggleSetting(key, v)} disabled={savingSettings} className="shrink-0" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* About */}
      <Card className="border-border" style={{ background: 'hsl(var(--card))' }}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold gradient-text font-['Space_Grotesk']">TradeMindMZ</span>
            <span className="text-xs text-muted-foreground">v1.0</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            AI Trading Assistant for Pionex. Provides AI-powered market analysis and paper trading simulation. This application does not provide financial advice. Always do your own research and manage your risk responsibly.
          </p>
          <Separator className="my-3 bg-border" />
          <p className="text-xs text-muted-foreground">
            Please modify the User Agreement and Privacy Policy to mitigate legal risks.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
