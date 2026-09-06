import ConfirmDialog from '../ConfirmDialog';

type ClearBoardModalProps = {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ClearBoardModal({
  isOpen,
  onConfirm,
  onCancel,
}: ClearBoardModalProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      title="Clear Board"
      body="This will remove all elements for all users. Are you sure?"
      confirmLabel="Clear Board"
      testIdPrefix="whiteboard-clear"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
