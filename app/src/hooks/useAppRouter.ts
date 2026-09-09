import { useRouter } from 'next/navigation';

// Plain Next router. The former View Transitions router was disabled on Linux
// (it crashes WebKitGTK), and Linux is the only target of this fork.
export const useAppRouter = () => useRouter();
